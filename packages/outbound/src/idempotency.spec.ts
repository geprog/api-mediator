import type { JsonRecord } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  computeDeleteIdempotencyKey,
  computePayloadHash,
  computeWriteIdempotencyKey,
  type PriorReconciledState,
} from "./idempotency.js";

/**
 * OC-2 — the deterministic idempotency key matrix. These prove the *inputs* the
 * concept fixes: prior reconciled state distinguishes a revert from a duplicate,
 * a delete keys on its marker + target native id, and everything is deterministic.
 */

const MAPPING = "mapping-1";
const SOURCE = "src-42";

function writeKey(payload: JsonRecord, prior: PriorReconciledState): string {
  return computeWriteIdempotencyKey({
    mappingId: MAPPING,
    sourceNativeId: SOURCE,
    payload,
    priorReconciledState: prior,
  });
}

describe("computeWriteIdempotencyKey", () => {
  it("A → X → Y → X: the reverting write keys differently from the first write", () => {
    // Field "name" reconciled at hash(A); write X.
    const first = writeKey({ name: "X" }, { kind: "reconciled", fieldHashes: { name: "hA" } });
    // Field reconciled at hash(X); write Y.
    const second = writeKey({ name: "Y" }, { kind: "reconciled", fieldHashes: { name: "hX" } });
    // Field reconciled at hash(Y); write X again (the revert).
    const revert = writeKey({ name: "X" }, { kind: "reconciled", fieldHashes: { name: "hY" } });

    // Same payload as the first write, but a DIFFERENT prior state → different key.
    // A payload-only key would wrongly dedupe the revert as a repeat of the first.
    expect(revert).not.toBe(first);
    expect(revert).not.toBe(second);
    expect(first).not.toBe(second);
  });

  it("a true duplicate (same payload AND same prior state) collides on the same key", () => {
    const prior: PriorReconciledState = { kind: "reconciled", fieldHashes: { name: "hA" } };
    const a = writeKey({ name: "X" }, prior);
    const b = writeKey({ name: "X" }, { kind: "reconciled", fieldHashes: { name: "hA" } });
    expect(a).toBe(b);
  });

  it("the `none` first-write marker keys differently from any reconciled state", () => {
    const firstWrite = writeKey({ name: "X" }, { kind: "none" });
    const fromState = writeKey({ name: "X" }, { kind: "reconciled", fieldHashes: { name: "hA" } });
    // A first write establishing state is distinct from a same-payload write over
    // a known prior state — and two `none` first writes of the same payload collide.
    expect(firstWrite).not.toBe(fromState);
    expect(firstWrite).toBe(writeKey({ name: "X" }, { kind: "none" }));
  });

  it("field-hash order does not matter (canonicalized)", () => {
    const a = writeKey({ name: "X" }, { kind: "reconciled", fieldHashes: { a: "1", b: "2" } });
    const b = writeKey({ name: "X" }, { kind: "reconciled", fieldHashes: { b: "2", a: "1" } });
    expect(a).toBe(b);
  });

  it("a different mapping id or source native id changes the key", () => {
    const base = writeKey({ name: "X" }, { kind: "none" });
    const otherMapping = computeWriteIdempotencyKey({
      mappingId: "mapping-2",
      sourceNativeId: SOURCE,
      payload: { name: "X" },
      priorReconciledState: { kind: "none" },
    });
    const otherSource = computeWriteIdempotencyKey({
      mappingId: MAPPING,
      sourceNativeId: "src-99",
      payload: { name: "X" },
      priorReconciledState: { kind: "none" },
    });
    expect(otherMapping).not.toBe(base);
    expect(otherSource).not.toBe(base);
  });
});

describe("computeDeleteIdempotencyKey", () => {
  it("duplicate deliveries of one deletion collide (mapping + source + marker + target id)", () => {
    const a = computeDeleteIdempotencyKey({
      mappingId: MAPPING,
      sourceNativeId: SOURCE,
      targetNativeId: "tgt-7",
    });
    const b = computeDeleteIdempotencyKey({
      mappingId: MAPPING,
      sourceNativeId: SOURCE,
      targetNativeId: "tgt-7",
    });
    expect(a).toBe(b);
  });

  it("a later delete of a re-created record (new native ids) keys differently", () => {
    const original = computeDeleteIdempotencyKey({
      mappingId: MAPPING,
      sourceNativeId: SOURCE,
      targetNativeId: "tgt-7",
    });
    const recreated = computeDeleteIdempotencyKey({
      mappingId: MAPPING,
      sourceNativeId: "src-43",
      targetNativeId: "tgt-8",
    });
    expect(recreated).not.toBe(original);
  });

  it("a delete never collides with a write of the same payload/ids (distinct marker)", () => {
    const del = computeDeleteIdempotencyKey({
      mappingId: MAPPING,
      sourceNativeId: SOURCE,
      targetNativeId: "tgt-7",
    });
    const write = writeKey({ id: "tgt-7" }, { kind: "none" });
    expect(del).not.toBe(write);
  });
});

describe("canonicalJson + computePayloadHash", () => {
  it("canonicalizes object key order and is deterministic", () => {
    expect(canonicalJson({ b: 1, a: [3, 2, { y: 1, x: 2 }] })).toBe(
      canonicalJson({ a: [3, 2, { x: 2, y: 1 }], b: 1 }),
    );
  });

  it("payload hash is stable across key order and differs on value change", () => {
    expect(computePayloadHash({ a: 1, b: 2 })).toBe(computePayloadHash({ b: 2, a: 1 }));
    expect(computePayloadHash({ a: 1 })).not.toBe(computePayloadHash({ a: 2 }));
  });
});
