import type { ApiSpec, IrOperation } from "@mediator/domain";

import type { GtOperationRef } from "./ground-truth.js";
import type { LoadedSpec } from "./scenario-loader.js";

/**
 * Reference alignment (EH-1 crit 4) — the bridge between the ground truth's
 * human-authored refs and the produced IR the detector actually reasons over.
 *
 * The ground truth names resources/operations/fields by IDENTITY (a resource
 * name, a `METHOD /path`, a field name), NOT by the produced `IrResourceGroup.
 * resourceRef` — and the two do not line up one-to-one. The IR builder groups by
 * `tags`/path-prefix, so several ground-truth resources collapse into one IR
 * group (in scenario-1, Gitea's `issues`, `labels`, `milestones` and
 * `issue-comments` all land in a single `issue` group; Vikunja's `tasks` and
 * `task-comments` share a `task` group). Scoring must therefore align by identity:
 *
 * - a ground-truth **resource** → the IR `resourceRef` that OWNS its operations
 *   (matched by `METHOD /path`), falling back to a normalized name match when the
 *   ground-truth resource lists no operations (a `negatives` resource endpoint);
 * - a ground-truth **operation** → matched against a produced item's `operationId`
 *   by resolving that id back to its `METHOD /path` through the IR;
 * - a ground-truth **field** → matched by its ROOT field name (so a produced
 *   top-level `labels` ↔ `labels` pairing matches a ground-truth nested
 *   `labels[].name` ↔ `labels[].title` pairing).
 *
 * Path-based file refs (trimmed vs full spec) are never used — matching is by
 * resource/operation/field identity, so the trimmed-vs-full split the fixtures
 * document is tolerated (a full-spec-only resource simply does not resolve, and is
 * reported as unresolved rather than crashing).
 */

/**
 * The separator for composite map keys built from two identity components
 * (`resourceRef` + `operationId`, or two spec ids). NUL is used because it cannot
 * occur in any of those identifiers, so the composite key stays injective — no two
 * distinct component pairs can collide.
 */
export const KEY_SEP = "\u0000";

// ── Operation identity ───────────────────────────────────────────────────────

/** The file-path-independent identity key of a ground-truth operation ref. */
export function operationRefKey(op: GtOperationRef): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}

/** The same identity key for an IR operation. */
export function irOperationKey(op: IrOperation): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}

// ── Spec lookup ──────────────────────────────────────────────────────────────

/** Find the loaded spec registered for a ground-truth app name. */
export function findSpec(specs: readonly LoadedSpec[], app: string): ApiSpec | undefined {
  return specs.find((loaded) => loaded.app === app)?.spec;
}

// ── Resource alignment ───────────────────────────────────────────────────────

/** Normalize a resource name to a naive singular, lower-case form for name matching. */
function normalizeResourceName(name: string): string {
  const n = name.toLowerCase().trim();
  if (n.endsWith("ies")) return `${n.slice(0, -3)}y`;
  if (n.endsWith("s") && !n.endsWith("ss")) return n.slice(0, -1);
  return n;
}

/**
 * Resolve a ground-truth resource to a produced IR `resourceRef`. Operation
 * membership is authoritative: the IR group owning the MOST of the resource's
 * operations wins (ties broken by IR order). When the resource lists no operations
 * (a `negatives` resource endpoint), fall back to a normalized name match against
 * each group's `resourceRef`/`name`. Returns `undefined` when nothing resolves
 * (e.g. a full-spec-only resource trimmed out of the detection input).
 */
export function resolveResourceRef(
  spec: ApiSpec,
  opRefs: readonly GtOperationRef[],
  resourceName: string,
): string | undefined {
  const byOps = resolveByOperations(spec, opRefs);
  if (byOps !== undefined) return byOps;
  return resolveByName(spec, resourceName);
}

function resolveByOperations(spec: ApiSpec, opRefs: readonly GtOperationRef[]): string | undefined {
  if (opRefs.length === 0) return undefined;
  const wanted = new Set(opRefs.map(operationRefKey));
  let best: { resourceRef: string; matches: number } | undefined;
  for (const group of spec.parsedIR) {
    let matches = 0;
    for (const op of group.operations) {
      if (wanted.has(irOperationKey(op))) matches += 1;
    }
    if (matches > 0 && (best === undefined || matches > best.matches)) {
      best = { resourceRef: group.resourceRef, matches };
    }
  }
  return best?.resourceRef;
}

function resolveByName(spec: ApiSpec, resourceName: string): string | undefined {
  const target = normalizeResourceName(resourceName);
  for (const group of spec.parsedIR) {
    if (
      normalizeResourceName(group.resourceRef) === target ||
      normalizeResourceName(group.name) === target
    ) {
      return group.resourceRef;
    }
  }
  return undefined;
}

// ── Item operationId → METHOD/path resolution ────────────────────────────────

/**
 * Build a lookup that resolves a produced operation/parameter item's
 * `(resourceRef, operationId)` back to its `METHOD /path` identity through the IR,
 * so a detected `operationMapping` can be compared to a ground-truth CRUD op. An
 * `operationId` is only unique within its resource group, hence the composite key.
 */
export function buildOperationRefLookup(
  spec: ApiSpec,
): (resourceRef: string, operationId: string) => GtOperationRef | undefined {
  const index = new Map<string, GtOperationRef>();
  for (const group of spec.parsedIR) {
    for (const op of group.operations) {
      const key = `${group.resourceRef}${KEY_SEP}${op.operationId}`;
      if (!index.has(key)) {
        index.set(key, { method: op.method.toUpperCase(), path: op.path });
      }
    }
  }
  return (resourceRef, operationId) => index.get(`${resourceRef}${KEY_SEP}${operationId}`);
}

// ── Field / parameter identity ───────────────────────────────────────────────

/**
 * The ROOT field name of a (possibly nested/array) field path — lower-cased, with
 * array markers and any nested suffix removed: `labels[].name` → `labels`,
 * `user.login` → `user`, `title` → `title`. Field-mapping scoring compares by this
 * root so a produced top-level pairing matches a ground-truth nested one.
 */
export function fieldRoot(name: string): string {
  const lower = name.toLowerCase().trim();
  const cut = lower.search(/[.[]/);
  return (cut === -1 ? lower : lower.slice(0, cut)).trim();
}

/**
 * The bare parameter name of a ground-truth parameter ref, dropping the
 * `location:` prefix the fixtures use (`query:page` → `page`, `path:listId` →
 * `listId`). Matched against a produced parameter item's `parameter` name.
 */
export function parameterName(ref: string): string {
  const idx = ref.indexOf(":");
  return (idx === -1 ? ref : ref.slice(idx + 1)).trim();
}
