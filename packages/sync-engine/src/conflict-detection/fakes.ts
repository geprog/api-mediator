import type { JsonRecord } from "@mediator/transform";

import type {
  ConflictDetectionMetrics,
  SingleRecordReadRequest,
  SingleRecordReadResult,
  SingleRecordTargetReader,
} from "./types.js";

/**
 * Counting {@link ConflictDetectionMetrics} for unit tests — asserts the conflict
 * rate is emitted per `SyncRule` (CF-1.5), once per recorded `conflict` `SyncEvent`
 * (auto-resolved and parked conflicts alike).
 */
export class FakeConflictDetectionMetrics implements ConflictDetectionMetrics {
  public conflicts: string[] = [];

  public recordConflict(ruleId: string): void {
    this.conflicts.push(ruleId);
  }
}

/**
 * In-memory {@link SingleRecordTargetReader} for unit tests. Canned records are keyed
 * by `(targetAppId, native id)`; a record can be marked **not-found** to exercise the
 * missing-target path. Every call is recorded so tests can assert the OC-3 load
 * discipline — **at most one read per execution** (CF memoizes) — and that the
 * default `none` + PATCH path reads the target **not at all** (CF-1.2).
 */
export class FakeSingleRecordTargetReader implements SingleRecordTargetReader {
  readonly #records = new Map<string, JsonRecord>();
  readonly #notFound = new Set<string>();
  readonly #calls: SingleRecordReadRequest[] = [];

  /** Provide the target's current record for `(targetAppId, native id)`. */
  public setRecord(targetAppId: string, nativeId: string, record: JsonRecord): void {
    this.#records.set(recordKey(targetAppId, nativeId), record);
  }

  /** Mark `(targetAppId, native id)` as not-found (the target record no longer exists). */
  public setNotFound(targetAppId: string, nativeId: string): void {
    this.#notFound.add(recordKey(targetAppId, nativeId));
  }

  public readRecord(request: SingleRecordReadRequest): Promise<SingleRecordReadResult> {
    this.#calls.push(request);
    const key = recordKey(request.targetAppId, request.nativeId);
    if (this.#notFound.has(key)) {
      return Promise.resolve({ found: false });
    }
    const record = this.#records.get(key);
    return Promise.resolve(record === undefined ? { found: false } : { found: true, record });
  }

  /** Every read made (test assertions — read count, chosen native id). */
  public get calls(): readonly SingleRecordReadRequest[] {
    return this.#calls;
  }
}

/** Canned-record map key — an escaped-space separator (never a NUL byte). */
function recordKey(targetAppId: string, nativeId: string): string {
  return `${targetAppId} ${nativeId}`;
}
