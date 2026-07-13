import { createHash } from "node:crypto";

import type { JsonRecord } from "@mediator/transform";

import { canonicalJson } from "../identity-resolution/hash.js";

/**
 * The **content hash** of one observed record — what the full-fetch snapshot stores
 * (`native id → content hash`) and diffs against (`docs/architecture/sync-engine.md`
 * *Polling pull pipeline*, *Change types*; SP-2). A changed hash for a native id
 * already in the snapshot is an update; an unchanged hash is not re-processed.
 *
 * It hashes the record's **canonical JSON** (object keys sorted, arrays ordered —
 * reusing the Identity Resolution serializer so the whole engine agrees on canonical
 * form), under its own scheme tag so it is never confused with a field hash or the
 * Outbound Call Executor's payload hash. The hash need only be internally consistent
 * and deterministic across polls, which canonical JSON + SHA-256 guarantees.
 */
const CONTENT_HASH_SCHEME = "poll-content-v1";

export function contentHashOfRecord(record: JsonRecord): string {
  return createHash("sha256")
    .update(`${CONTENT_HASH_SCHEME}:${canonicalJson(record)}`, "utf8")
    .digest("hex");
}
