import type { AuditLogEntry, RecordLink, SyncFieldState, TombstoneReason } from "@mediator/domain";
import type { RecordLinkSideRef, RecordLinkStore, SyncFieldStateStore } from "@mediator/db";
import { readPath, type JsonValue } from "@mediator/transform";

import { valuesAgree } from "./hash.js";
import type {
  FetchAllRequest,
  FilteredReadRequest,
  IdentityResolutionMetrics,
  MatchedTargetRecord,
  SyncEventRecorder,
  TargetFetchResult,
  TargetIdentityLookup,
} from "./types.js";

/**
 * In-memory {@link RecordLinkStore} that **faithfully mirrors** the real
 * `RecordLinkRepository` + its partial-unique-active indexes
 * ([[fakes-must-mirror-real-repos]]): a loose fake would mask the silent-merge bug
 * RL-4 guards against, so it enforces the two invariants that matter:
 *
 *  - **unique-active-link** — {@link insert} throws {@link UniqueActiveLinkViolation}
 *    when an **active** link already exists for the same `(resource pair, side, app,
 *    native id)`, per side — exactly the two `WHERE status = 'active'` partial-unique
 *    indexes (a tombstoned/archived link does not block a fresh active one);
 *  - **tombstone-not-delete** — {@link tombstone} flips status + reason + timestamp
 *    and keeps the row; only {@link unlink} removes one.
 */
export class UniqueActiveLinkViolation extends Error {
  public constructor(resourcePairRef: string) {
    super(`unique-active-link violation for resource pair ${resourcePairRef}`);
    this.name = "UniqueActiveLinkViolation";
  }
}

export class FakeRecordLinkStore implements RecordLinkStore {
  readonly #links: RecordLink[] = [];

  public findActiveByRecord(
    resourcePairRef: string,
    record: RecordLinkSideRef,
  ): Promise<RecordLink | undefined> {
    const found = this.#links.find(
      (link) =>
        link.status === "active" &&
        link.resourcePairRef === resourcePairRef &&
        onEitherSide(link, record),
    );
    return Promise.resolve(found === undefined ? undefined : clone(found));
  }

  public findTombstonedByRecord(
    resourcePairRef: string,
    record: RecordLinkSideRef,
  ): Promise<RecordLink | undefined> {
    const found = this.#links
      .filter(
        (link) =>
          link.status === "tombstoned" &&
          link.resourcePairRef === resourcePairRef &&
          onEitherSide(link, record),
      )
      .sort((a, b) => tombstonedAtMs(b) - tombstonedAtMs(a))[0];
    return Promise.resolve(found === undefined ? undefined : clone(found));
  }

  public insert(link: RecordLink): Promise<void> {
    if (link.status === "active") {
      // Mirror the two partial-unique-active indexes: per side, at most one active
      // link per (resource pair, app, native id). Same-side (not cross-side), exactly
      // as the DB indexes are keyed by fixed column sets.
      const conflict = this.#links.some(
        (existing) =>
          existing.status === "active" &&
          existing.resourcePairRef === link.resourcePairRef &&
          ((existing.appAId === link.appAId && existing.appANativeId === link.appANativeId) ||
            (existing.appBId === link.appBId && existing.appBNativeId === link.appBNativeId)),
      );
      if (conflict) {
        // Reject (not throw synchronously) — mirrors the real Drizzle insert surfacing
        // a partial-unique-index violation as a rejected promise.
        return Promise.reject(new UniqueActiveLinkViolation(link.resourcePairRef));
      }
    }
    this.#links.push(clone(link));
    return Promise.resolve();
  }

  public tombstone(id: string, reason: TombstoneReason, tombstonedAt: Date): Promise<void> {
    const link = this.#links.find((entry) => entry.id === id);
    if (link !== undefined) {
      link.status = "tombstoned";
      link.tombstoneReason = reason;
      link.tombstonedAt = tombstonedAt;
    }
    return Promise.resolve();
  }

  public unlink(id: string): Promise<void> {
    const index = this.#links.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.#links.splice(index, 1);
    }
    return Promise.resolve();
  }

  public getById(id: string): Promise<RecordLink | undefined> {
    const found = this.#links.find((entry) => entry.id === id);
    return Promise.resolve(found === undefined ? undefined : clone(found));
  }

  /** Every stored link (test assertions). */
  public all(): readonly RecordLink[] {
    return this.#links.map(clone);
  }
}

/**
 * In-memory {@link SyncFieldStateStore} mirroring the real repo's monotone seed
 * (`ON CONFLICT (record_link_id, side, field_path) DO NOTHING`): a row already
 * present for a `(link, side, field)` is left untouched, never overwritten.
 */
export class FakeSyncFieldStateStore implements SyncFieldStateStore {
  readonly #rows: SyncFieldState[] = [];

  public seed(rows: readonly SyncFieldState[]): Promise<void> {
    for (const row of rows) {
      const exists = this.#rows.some(
        (existing) =>
          existing.recordLinkId === row.recordLinkId &&
          existing.side === row.side &&
          existing.fieldPath === row.fieldPath,
      );
      if (!exists) {
        this.#rows.push({ ...row });
      }
    }
    return Promise.resolve();
  }

  public findByLink(recordLinkId: string): Promise<SyncFieldState[]> {
    const rows = this.#rows
      .filter((row) => row.recordLinkId === recordLinkId)
      .sort((a, b) => a.side.localeCompare(b.side) || a.fieldPath.localeCompare(b.fieldPath))
      .map((row) => ({ ...row }));
    return Promise.resolve(rows);
  }

  /** Every stored row (test assertions). */
  public all(): readonly SyncFieldState[] {
    return this.#rows.map((row) => ({ ...row }));
  }
}

/** One target app's records for the fake lookup, plus how the target "filters". */
export interface FakeTargetConfig {
  /** The target's identity field path — what a filtered read filters on / fetch-and-match compares. */
  readonly identityFieldPath: string;
  readonly records: readonly MatchedTargetRecord[];
  /** When true, `fetchAll` returns `{ complete: false }` (a partial-fetch abort). */
  readonly incomplete?: boolean;
}

/**
 * In-memory {@link TargetIdentityLookup} for unit tests. `filteredRead` simulates the
 * target applying its filter parameter (returns records whose identity field equals
 * the queried value); `fetchAll` returns the whole configured set (or a partial-fetch
 * abort). Records every call so tests can assert the value was passed **AS-IS**
 * (RL-3.3) and which path was chosen (RL-3.1/3.2).
 */
export class FakeTargetIdentityLookup implements TargetIdentityLookup {
  readonly #targets = new Map<string, FakeTargetConfig>();
  readonly #filteredReadCalls: FilteredReadRequest[] = [];
  readonly #fetchAllCalls: FetchAllRequest[] = [];

  public setTarget(targetAppId: string, config: FakeTargetConfig): void {
    this.#targets.set(targetAppId, config);
  }

  public filteredRead(request: FilteredReadRequest): Promise<readonly MatchedTargetRecord[]> {
    this.#filteredReadCalls.push(request);
    const config = this.#targets.get(request.targetAppId);
    if (config === undefined) {
      return Promise.resolve([]);
    }
    const matches = config.records.filter((candidate) =>
      fieldEquals(candidate, config.identityFieldPath, request.value),
    );
    return Promise.resolve(matches);
  }

  public fetchAll(request: FetchAllRequest): Promise<TargetFetchResult> {
    this.#fetchAllCalls.push(request);
    const config = this.#targets.get(request.targetAppId);
    if (config === undefined) {
      return Promise.resolve({ complete: true, records: [] });
    }
    if (config.incomplete === true) {
      return Promise.resolve({ complete: false });
    }
    return Promise.resolve({ complete: true, records: config.records });
  }

  /** The filtered-read calls made (test assertions — value used AS-IS, path chosen). */
  public get filteredReadCalls(): readonly FilteredReadRequest[] {
    return this.#filteredReadCalls;
  }

  /** The fetch-and-match calls made (test assertions). */
  public get fetchAllCalls(): readonly FetchAllRequest[] {
    return this.#fetchAllCalls;
  }
}

/**
 * In-memory {@link SyncEventRecorder} — records the stage's own resolution events
 * (RL-4 ambiguous failure, RL-5 skipped-policy). Mirrors the shape of
 * `@mediator/outbound`'s `FakeSyncEventStore.record` without importing it (no cycle).
 */
export class FakeSyncEventRecorder implements SyncEventRecorder {
  readonly #entries: AuditLogEntry[] = [];

  public record(entry: AuditLogEntry): Promise<void> {
    this.#entries.push(entry);
    return Promise.resolve();
  }

  /** Every recorded event, in insertion order (test assertions). */
  public all(): readonly AuditLogEntry[] {
    return [...this.#entries];
  }
}

/** Counting {@link IdentityResolutionMetrics} — asserts no-match vs. ambiguous-match are distinct. */
export class FakeIdentityResolutionMetrics implements IdentityResolutionMetrics {
  public noMatch: string[] = [];
  public ambiguousMatch: string[] = [];

  public recordNoMatch(ruleId: string): void {
    this.noMatch.push(ruleId);
  }

  public recordAmbiguousMatch(ruleId: string): void {
    this.ambiguousMatch.push(ruleId);
  }
}

function onEitherSide(link: RecordLink, record: RecordLinkSideRef): boolean {
  return (
    (link.appAId === record.appId && link.appANativeId === record.nativeId) ||
    (link.appBId === record.appId && link.appBNativeId === record.nativeId)
  );
}

function fieldEquals(
  candidate: MatchedTargetRecord,
  identityFieldPath: string,
  value: JsonValue,
): boolean {
  const field = readPath(candidate.record, identityFieldPath);
  return field.present && valuesAgree(field.value, value);
}

function tombstonedAtMs(link: RecordLink): number {
  return link.tombstonedAt === null ? 0 : link.tombstonedAt.getTime();
}

function clone(link: RecordLink): RecordLink {
  return { ...link };
}
