import type { ScopeKey } from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";

import { canonicalJson } from "../identity-resolution/hash.js";

/**
 * The **canonical A/B assignment** of a container pair (SS-11 invariant:
 * *direction-agnostic, one canonical link per container pair*). A `ScopeLink`'s
 * `resourcePairRef` is direction-agnostic, so a link discovered from either direction
 * must land on the **same** row. We assign `appAId`/`appBId` by **lexicographic `appId`
 * ordering** — the same stable key the canonical `resourcePairRef` orders its two sides
 * by (`appId:resourceRef|appId:resourceRef`, sorted) — so the `ScopeLink`'s side A aligns
 * with the `resourcePairRef`'s side A and both directions compute an identical link.
 */
export interface CanonicalScopeSides {
  readonly appAId: string;
  readonly appAScopeKey: ScopeKey;
  readonly appBId: string;
  readonly appBScopeKey: ScopeKey;
}

/**
 * Assign a source/target container pair to canonical `(appA, appB)` by lexicographic
 * `appId`. A scoped resource pair is **cross-app**, so the two appIds always differ; a
 * same-appId pair is an unrepresentable self-scope and throws (fail loud). The scope keys
 * travel with their app, so the addressing key stays correct on whichever side it lands.
 */
export function canonicalScopeSides(params: {
  readonly sourceAppId: string;
  readonly sourceScopeKey: ScopeKey;
  readonly targetAppId: string;
  readonly targetScopeKey: ScopeKey;
}): CanonicalScopeSides {
  if (params.sourceAppId === params.targetAppId) {
    throw new Error(
      "a ScopeLink correlates two DIFFERENT apps' containers — got the same appId on both sides",
    );
  }
  return params.sourceAppId < params.targetAppId
    ? {
        appAId: params.sourceAppId,
        appAScopeKey: params.sourceScopeKey,
        appBId: params.targetAppId,
        appBScopeKey: params.targetScopeKey,
      }
    : {
        appAId: params.targetAppId,
        appAScopeKey: params.targetScopeKey,
        appBId: params.sourceAppId,
        appBScopeKey: params.sourceScopeKey,
      };
}

/**
 * The **scope identity signature** of a container: the canonical serialization of the
 * scope-identity-key pairing values, **in pairing order**. Both sides (source and target)
 * are serialized by this one function so two containers with equal identity-key values
 * always produce the identical string, regardless of side — the value-preserving match
 * test (SS-11.2), reusing the same canonical-JSON serializer Identity Resolution keys on.
 * The values are compared AS-IS; the adapter applies only the value-preserving (`rename`)
 * transform the scope identity key permits before calling this.
 */
export function scopeIdentitySignature(values: readonly JsonValue[]): string {
  return canonicalJson([...values]);
}
