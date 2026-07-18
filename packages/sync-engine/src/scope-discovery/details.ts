import type { ScopeKey } from "@mediator/domain";

/**
 * The `SyncEvent.details` encoding for an **ambiguous container match** (SS-11.2/11.5 —
 * the container analog of RL-4's ambiguous-identity `failure` event). Format and parse
 * are colocated here (one source of truth) so the discovery stage that *records* the
 * event and the operator read that *surfaces* it (`listParkedContainerLinks`) agree
 * verbatim — a container's scope key + native ids are operator config, not secrets
 * (`docs/architecture/security.md` — scope values are operator config), so encoding them
 * breaches no data boundary (discovery reads only container identity, never a record's
 * payload).
 *
 * The string keeps a human-readable RL-4-style prefix + candidate list, then a machine
 * tail (` :: <json>`) the read parses to drop matches an operator has since linked.
 */
export const AMBIGUOUS_CONTAINER_DETAILS_PREFIX = "ambiguous container match";

const DETAILS_MACHINE_SEPARATOR = " :: ";

/** The structured payload behind an ambiguous-container `failure` event's `details`. */
export interface AmbiguousContainerDetails {
  readonly resourcePairRef: string;
  readonly sourceAppId: string;
  readonly sourceScopeKey: ScopeKey;
  readonly candidateNativeIds: readonly string[];
}

/** Encode an ambiguous container match into a `SyncEvent.details` string. */
export function formatAmbiguousContainerDetails(details: AmbiguousContainerDetails): string {
  const list = details.candidateNativeIds.join(", ");
  const machine = JSON.stringify({
    resourcePairRef: details.resourcePairRef,
    sourceAppId: details.sourceAppId,
    sourceScopeKey: details.sourceScopeKey,
    candidateNativeIds: details.candidateNativeIds,
  });
  return `${AMBIGUOUS_CONTAINER_DETAILS_PREFIX}: ${String(
    details.candidateNativeIds.length,
  )} candidate containers [${list}]${DETAILS_MACHINE_SEPARATOR}${machine}`;
}

/**
 * Decode an ambiguous-container `failure` event's `details`, or `undefined` when it is
 * not one / is malformed (a defensive parse over untrusted stored text — no `any`). The
 * caller drops non-container `failure` events before calling, but this validates the
 * shape fully so a hand-edited row can never widen a type.
 */
export function parseAmbiguousContainerDetails(
  details: string,
): AmbiguousContainerDetails | undefined {
  if (!details.startsWith(AMBIGUOUS_CONTAINER_DETAILS_PREFIX)) {
    return undefined;
  }
  const separator = details.indexOf(DETAILS_MACHINE_SEPARATOR);
  if (separator < 0) {
    return undefined;
  }
  const json = details.slice(separator + DETAILS_MACHINE_SEPARATOR.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return toAmbiguousContainerDetails(parsed);
}

function toAmbiguousContainerDetails(value: unknown): AmbiguousContainerDetails | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const resourcePairRef = record.resourcePairRef;
  const sourceAppId = record.sourceAppId;
  const sourceScopeKey = toScopeKey(record.sourceScopeKey);
  const candidateNativeIds = toStringArray(record.candidateNativeIds);
  if (
    typeof resourcePairRef !== "string" ||
    typeof sourceAppId !== "string" ||
    sourceScopeKey === undefined ||
    candidateNativeIds === undefined
  ) {
    return undefined;
  }
  return { resourcePairRef, sourceAppId, sourceScopeKey, candidateNativeIds };
}

function toScopeKey(value: unknown): ScopeKey | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return undefined;
    }
    out[key] = entry;
  }
  return out;
}

function toStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    out.push(entry);
  }
  return out;
}
