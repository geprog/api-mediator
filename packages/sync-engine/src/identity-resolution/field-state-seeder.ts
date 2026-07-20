import { randomUUID } from "node:crypto";

import {
  type FieldMapping,
  recordRelativePath,
  type SyncFieldState,
  type SyncFieldStateSide,
} from "@mediator/domain";
import type { SyncFieldStateStore } from "@mediator/db";
import {
  applyFieldMapping,
  isTransformError,
  readPath,
  type JsonRecord,
  type JsonValue,
} from "@mediator/transform";

import { hashFieldValue, valuesAgree } from "./hash.js";

/**
 * The **per-link identity-match seed** RL-3.4 invokes (the same agree/disagree
 * seeding link-only backfill performs — BE-4 owns the full multi-direction,
 * monotone backfill; this seeds one freshly established link).
 *
 * For each `FieldMapping` of this direction it writes one `SyncFieldState` row per
 * participating side-field, in that side's own canonical representation:
 *  - **observed** state is always recorded (the current source/target value);
 *  - the **reconciled baseline** (`lastSyncedHash`/`lastSyncedAt`) is recorded **only
 *    when the two sides agree** — agreement is defined in the target's representation
 *    (`docs/architecture/sync-engine.md` *Initial backfill*): applying the mapping's
 *    transform to the source value reproduces the target's stored value. Disagreeing
 *    fields get **no** baseline, so their first subsequent change is a conflict by
 *    construction.
 *
 * A transform that errors on the seed value counts as **disagreement** (it did not
 * reproduce the target value) — never a fabricated baseline. Writes are **monotone**
 * (`SyncFieldStateStore.seed` never erases an existing baseline).
 */
export interface IdentityMatchSeederOptions {
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

/** The per-link seed inputs the stage hands the seeder on a single-match link. */
export interface IdentityMatchSeedInput {
  readonly recordLinkId: string;
  /** Which side of the link the change's source app is (its fields live in the source representation). */
  readonly sourceSide: SyncFieldStateSide;
  /** The opposite side — the matched target record's representation. */
  readonly targetSide: SyncFieldStateSide;
  /** This direction's field pairings (the identity key plus any confirmed field mappings). */
  readonly fieldMappings: readonly FieldMapping[];
  /** The source record as observed this poll. */
  readonly observedSource: JsonRecord;
  /** The matched target record the lookup returned. */
  readonly matchedTarget: JsonRecord;
}

function inputPaths(field: FieldMapping): readonly string[] {
  return [field.sourcePath, ...(field.transformConfig?.additionalInputPaths ?? [])];
}

export class IdentityMatchSeeder {
  readonly #store: SyncFieldStateStore;
  readonly #clock: () => Date;
  readonly #newId: () => string;

  public constructor(store: SyncFieldStateStore, options: IdentityMatchSeederOptions = {}) {
    this.#store = store;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
  }

  /** Seed the link's per-side-field rows; returns the rows written (for tests/inspection). */
  public async seed(input: IdentityMatchSeedInput): Promise<SyncFieldState[]> {
    const now = this.#clock();
    // Dedup by (side, fieldPath): a field participating in several pairings yields one
    // row; a baseline-bearing row wins over one without (monotone-friendly).
    const byKey = new Map<string, SyncFieldState>();

    const put = (
      side: SyncFieldStateSide,
      fieldPath: string,
      value: JsonValue,
      agree: boolean,
    ): void => {
      const observedHash = hashFieldValue(value);
      const row: SyncFieldState = {
        id: this.#newId(),
        recordLinkId: input.recordLinkId,
        side,
        fieldPath,
        observedHash,
        observedAt: now,
        observedChangeTimestamp: null,
        status: "active",
        ...(agree ? { lastSyncedHash: observedHash, lastSyncedAt: now } : {}),
      };
      const key = `${side}\u0000${fieldPath}`;
      const existing = byKey.get(key);
      if (existing === undefined || (existing.lastSyncedHash === undefined && agree)) {
        byKey.set(key, row);
      }
    };

    for (const field of input.fieldMappings) {
      // Reads go through `recordRelativePath` (live records are record-relative); the
      // `SyncFieldState.fieldPath` KEYS stay in the stored, resource-qualified space —
      // the same space `participatingFieldsForSide` derives the echo compare's paths in,
      // so seeded rows and the loop-prevention lookup keep agreeing.
      const targetRead = readPath(input.matchedTarget, recordRelativePath(field.targetPath));
      const agree =
        targetRead.present && this.#pairingAgrees(field, input.observedSource, targetRead.value);

      for (const path of inputPaths(field)) {
        const read = readPath(input.observedSource, recordRelativePath(path));
        put(input.sourceSide, path, read.present ? read.value : null, agree);
      }
      put(input.targetSide, field.targetPath, targetRead.present ? targetRead.value : null, agree);
    }

    const rows = [...byKey.values()];
    await this.#store.seed(rows);
    return rows;
  }

  /**
   * Two sides *agree* for a pairing when applying the mapping's transform to the
   * source reproduces the target's stored value — evaluated in the target's
   * representation, so the comparison never crosses the transform boundary. A
   * transform error is disagreement (no baseline), never a thrown seed.
   */
  #pairingAgrees(field: FieldMapping, source: JsonRecord, targetValue: JsonValue): boolean {
    try {
      const applied = applyFieldMapping(field, source);
      return valuesAgree(applied.value, targetValue);
    } catch (error) {
      if (isTransformError(error)) {
        return false;
      }
      throw error;
    }
  }
}
