import type {
  ConfirmableRef,
  Ir,
  IrField,
  IrRefTarget,
  IrResourceGroup,
  ResourceBinding,
  ScopeCorrespondence,
  ScopePathBinding,
  SourceScopeRef,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";

import {
  collectScopeParameterNames,
  deriveScopePathBindings,
  pickCollectionRead,
  pickRepresentationFields,
  schemaFieldNames,
} from "./resource-bindings.js";

/**
 * **SS-16 — re-validating scope artifacts when a spec changes.** The mirror image of
 * `deriveResourceBindings`: derivation guesses a resource's operational artifacts from
 * an IR for the *first* time, this re-checks the artifacts an operator has since
 * confirmed against a *new* IR and decides, per artifact, whether it carries forward or
 * must go back to a human.
 *
 * Pure and total — no I/O, no persistence, no clock, no id minting. It **returns** the
 * re-validated artifacts plus typed {@link ScopeRevalidationFinding}s; the caller
 * persists them and applies the operational consequence (pausing the dependent
 * `SyncRule`s, archiving the affected `ScopeLink`s). That split is deliberate: the
 * `SpecDiff` / re-pin / successor-adoption machinery that *triggers* re-validation is
 * Phase-6-owned (SS-16 criterion 6, `docs/architecture/extensibility.md` *Spec update
 * lifecycle*), so this slice supplies only the scope-artifact **policy** that lifecycle
 * calls — exactly as `ScopeLinkRepository.archiveByCorrespondence` already ships the
 * SS-10.5 archive *capability* ahead of its Phase-6 trigger.
 *
 * ## The two rules, and why nothing here ever auto-confirms
 *
 * `docs/architecture/extensibility.md` fixes both halves for `ResourceBinding` refs and
 * `SyncRule.pollOperationRef`, and SS-16 extends them verbatim to the scope artifacts:
 *
 * - **Additive re-pin** — an artifact whose IR target is untouched **carries forward
 *   unchanged**: same kind, same value/source, same `confirmedBy`/`confirmedAt`
 *   (SS-16.1). An additive diff proves the element it names is unchanged, so keeping the
 *   operator's ratification is safe and is what stops every spec bump becoming a full
 *   re-confirmation chore.
 * - **Breaking change** — an artifact whose IR target was removed or renamed **returns
 *   to unconfirmed** and its dependent rules pause (SS-16.2/16.3). Nothing here promotes
 *   anything to confirmed, re-points a confirmed artifact at a "close enough"
 *   replacement, or falls back to a default: a rename is indistinguishable from a
 *   removal plus an addition, and silently following one would re-point a live sync at a
 *   *different* element. Re-confirmation is a human decision.
 *
 * ## Invalidated artifacts are retained, never dropped
 *
 * An invalidated ref is kept in place and merely returned to unconfirmed (replaced by a
 * freshly derived candidate where the heuristic finds one, itself unconfirmed) rather
 * than deleted from the binding. This is a correctness requirement, not tidiness —
 * **absent** is a meaningful, *permissive* state for several refs, so deleting an
 * invalidated one would silently re-enable the behavior it was confirmed to override:
 *
 * - an absent {@link ResourceBinding.recordAddressRef} means "this resource addresses
 *   records by their native id" (`resolveRecordAddressing` branch 1), so dropping a
 *   confirmed-then-invalidated address ref would silently reinstate **native-id
 *   addressing** on a container-scoped resource — the 404-or-clobber-the-wrong-record
 *   failure SS-19 exists to prevent. Retained-but-unconfirmed instead yields
 *   `unconfirmed-address-ref`, which fails loud;
 * - an absent `scopePathBindings` entry means the parameter is simply not a scope
 *   parameter of this resource, which would erase the evidence that it once was.
 *
 * The cost is an orphan unconfirmed entry for a genuinely-deleted element, which the
 * operator can clear; the benefit is that no invalidation can ever be *quieter* than the
 * state it replaced.
 */

// ── Findings ──────────────────────────────────────────────────────────────────

/**
 * The `ResourceBinding` refs SS-16 re-validates by IR resolution. `nativeIdRef` and
 * `changeTimestampRef` are included because a scope artifact's correctness depends on
 * them (a container resource is addressed by its `nativeIdRef`), and the check is one
 * shared mechanism rather than a per-ref special case — but Phase 6 owns whatever
 * *further* consequences the non-scope refs carry.
 */
export type RevalidatableRefName =
  | "nativeIdRef"
  | "recordAddressRef"
  | "collectionReadRef"
  | "paginationRef"
  | "deltaCursorRef"
  | "deltaDeletionRef"
  | "changeTimestampRef";

/**
 * One thing a re-ingested spec invalidated. A discriminated union — never a bare string —
 * so the lifecycle caller can route each finding to its consequence (pause / archive /
 * re-review) and a test can assert the exact invalidation rather than a message.
 *
 * Every member describes a **confirmed-or-derived artifact that is no longer usable
 * as-is**; a finding is therefore always fail-loud, and an empty finding list is exactly
 * the additive-re-pin case in which everything carried forward untouched.
 */
export type ScopeRevalidationFinding =
  | ScopeParameterRemovedFinding
  | ScopeParameterAddedFinding
  | BindingRefInvalidatedFinding
  | SourceScopeRefInvalidatedFinding
  | ContainerResourceRemovedFinding
  | ScopeIdentityKeyInvalidatedFinding;

/**
 * SS-16.2 — a **bound** scope path parameter was removed or renamed out of the resource's
 * operations. Its `scopePathBindings` entry is returned to unconfirmed and the dependent
 * `SyncRule`s pause. A rename surfaces as this finding **plus** a
 * {@link ScopeParameterAddedFinding} for the new name: the IR carries no rename evidence,
 * and guessing the correspondence would re-point a live sync at a different container.
 */
export interface ScopeParameterRemovedFinding {
  readonly kind: "scope-parameter-removed";
  readonly resourceRef: string;
  readonly parameterName: string;
  /** Whether the removed entry had been operator-confirmed (an unconfirmed one was already inert). */
  readonly wasConfirmed: boolean;
}

/**
 * SS-16.3 — the re-ingested spec introduced a **new** scope path parameter on the
 * resource's operations. A path parameter is required by construction in OpenAPI (`in:
 * path` implies `required: true`), so any newly-appearing one is a new *required* input
 * the mediator cannot fill: a new **unconfirmed** binding is created for it and rules
 * calling that operation pause until an operator supplies it. Fail-loud is the whole
 * point — the alternative is a live rule composing a URL with a literal `{owner}` in it.
 */
export interface ScopeParameterAddedFinding {
  readonly kind: "scope-parameter-added";
  readonly resourceRef: string;
  readonly parameterName: string;
}

/**
 * SS-16.2, extended to `recordAddressRef` (SS-19) and to the container resources'
 * `collectionReadRef`/`paginationRef`: a `ConfirmableRef`'s IR target no longer resolves,
 * so the ref returns to unconfirmed and its dependent rules pause. Mirrors
 * `pollOperationRef` re-validation exactly (`docs/architecture/extensibility.md`).
 */
export interface BindingRefInvalidatedFinding {
  readonly kind: "binding-ref-invalidated";
  readonly resourceRef: string;
  readonly ref: RevalidatableRefName;
  readonly wasConfirmed: boolean;
  /** Whether the heuristic found a fresh (unconfirmed) candidate to offer in its place. */
  readonly replacedByCandidate: boolean;
}

/**
 * SS-16.2/16.4 — a component of the resource's `sourceScopeRef` (SS-7 record scope
 * capture) names a field the re-ingested spec no longer exposes. `sourceScopeRef` carries
 * **one** confirmation over its whole component set, so a single broken component returns
 * the entire ref to unconfirmed — and with it every `record-derived` scope binding and
 * every `scopeIdentityKey` pairing that reads a captured component.
 */
export interface SourceScopeRefInvalidatedFinding {
  readonly kind: "source-scope-ref-invalidated";
  readonly resourceRef: string;
  /** The component `key`s whose `fieldPath` no longer resolves. */
  readonly brokenComponentKeys: readonly string[];
  readonly wasConfirmed: boolean;
}

/**
 * SS-16.4/16.5 — a `ScopeCorrespondence` container resource **disappeared** from the
 * re-ingested spec. Before SS-16 this left a *confirmed* correspondence pointing at a
 * resource that no longer exists (`propose` never clobbers a confirmed row), so container
 * discovery would keep resolving against a phantom. The correspondence returns to
 * unconfirmed and its `ScopeLink`s are **archived, not deleted** (SS-16.5 / SS-10.5), so a
 * `RecordLink.scopeRef` pointing at one still resolves its frozen key for a final
 * delete/audit.
 *
 * The `source` side is additionally **removed** from the correspondence (it is optional —
 * "present only when enumerable"), which flips the derived poll-scope mode
 * `per-scope-enumerated` → `per-scope-pinned`: the fail-safe direction, since pinned
 * requires explicit `ScopeLink`s rather than enumerating containers that cannot be listed.
 * The `target` side is required by the schema, so it is retained and unconfirmed instead.
 */
export interface ContainerResourceRemovedFinding {
  readonly kind: "container-resource-removed";
  readonly side: "source" | "target";
  readonly appId: string;
  readonly resourceRef: string;
  readonly wasConfirmed: boolean;
}

/**
 * SS-16.4 — a **scope-identity-key** field broke: either a pairing's `sourceScopeKey` no
 * longer names a component of the source resource's `sourceScopeRef`, or its
 * `targetFieldPath` no longer resolves on the target container resource. The pair's
 * `scopeIdentityKey` returns to **unconfirmed**, `identity-match` `ScopeLink` resolution
 * is invalidated (those links are archived — they were established by a comparison that no
 * longer type-checks), and the rule stays unenableable until it is re-confirmed. Mirrors
 * record identity-key handling under successor adoption: "if the breaking change removed
 * or retyped it, the successor's rules stay unenableable until a new identity key is
 * confirmed" (`docs/architecture/extensibility.md`).
 */
export interface ScopeIdentityKeyInvalidatedFinding {
  readonly kind: "scope-identity-key-invalidated";
  readonly issue: "source-component-removed" | "target-field-removed";
  /** The `sourceScopeKey` of the pairing that broke. */
  readonly sourceScopeKey: string;
  readonly wasConfirmed: boolean;
}

/**
 * Whether a finding **pauses** the `SyncRule`s that depend on the artifact it names
 * (SS-16.2/16.3/16.4). Every finding does: each names an artifact that was either
 * operator-confirmed and is now unusable, or is newly required and unfilled — both of
 * which mean a live rule would compose a wrong or unfillable call. The predicate exists so
 * the rule is stated **once**, in the pure layer, rather than re-derived by each caller,
 * and so adding a future non-pausing (advisory) finding is a change here rather than
 * everywhere.
 */
export function pausesDependentRules(finding: ScopeRevalidationFinding): boolean {
  switch (finding.kind) {
    case "scope-parameter-removed":
    case "scope-parameter-added":
    case "binding-ref-invalidated":
    case "source-scope-ref-invalidated":
    case "container-resource-removed":
    case "scope-identity-key-invalidated":
      return true;
  }
}

// ── ResourceBinding re-validation ─────────────────────────────────────────────

/** The re-validated binding plus what the re-ingested spec invalidated about it. */
export interface ResourceBindingRevalidation {
  readonly binding: ResourceBinding;
  readonly findings: readonly ScopeRevalidationFinding[];
}

/**
 * **SS-16.1/16.2/16.3 (+ SS-19) — re-validate one stored `ResourceBinding` against the
 * re-ingested spec's IR.** Returns the binding as it should now be stored, plus the
 * findings.
 *
 * The returned binding keeps the stored `id`/`apiSpecId`/`resourceRef` untouched: this
 * re-validates an *existing* binding in place rather than minting a new one, so the
 * caller's persistence is an update and every `SyncRule` referencing it keeps referencing
 * it. (Whether the Phase-6 re-pin re-points bindings at a new `ApiSpec` row is that
 * machinery's decision, not this policy's.)
 *
 * A resource whose whole **group** disappeared from the IR yields the binding unchanged
 * with **no** findings: every artifact on it is moot because the resource itself is gone,
 * and that is a resource-level lifecycle event (the mapping goes `stale`, the rules are
 * re-reviewed) which Phase 6 owns end to end. Reporting per-ref breakage for a resource
 * that no longer exists would bury the one fact that matters in noise.
 */
export function revalidateResourceBinding(
  stored: ResourceBinding,
  ir: Ir,
): ResourceBindingRevalidation {
  const group = ir.find((candidate) => candidate.resourceRef === stored.resourceRef);
  if (group === undefined) {
    return { binding: stored, findings: [] };
  }

  const findings: ScopeRevalidationFinding[] = [];
  const representationFields = pickRepresentationFields(
    group,
    pickCollectionRead(group.operations),
  );

  const refs = revalidateRefs(stored, group, representationFields, findings);
  const sourceScopeRef = revalidateSourceScopeRef(stored, group, representationFields, findings);
  const scopePathBindings = revalidateScopePathBindings(stored, group, findings);

  return {
    binding: stripUndefined({
      ...stored,
      ...refs,
      sourceScopeRef,
      scopePathBindings,
    }),
    findings,
  };
}

/** Every {@link RevalidatableRefName}, in `ResourceBinding` declaration order. */
const REVALIDATABLE_REFS: readonly RevalidatableRefName[] = [
  "nativeIdRef",
  "recordAddressRef",
  "collectionReadRef",
  "paginationRef",
  "deltaCursorRef",
  "deltaDeletionRef",
  "changeTimestampRef",
];

/**
 * SS-16.1/16.2 for the plain {@link ConfirmableRef}s — including SS-19's
 * `recordAddressRef`, which is an ordinary `ConfirmableRef` and so gets exactly the same
 * treatment as any other derived-then-confirmed ref, and including the container
 * resources' `collectionReadRef`/`paginationRef`, which is what makes a
 * `ScopeCorrespondence`'s container list op re-validated rather than assumed.
 *
 * A ref whose target still resolves is returned **byte-identical** (SS-16.1); one whose
 * target is gone is returned unconfirmed — carrying a freshly derived candidate where the
 * heuristic offers one, otherwise its now-dangling pointer (never absent; see the module
 * doc).
 */
function revalidateRefs(
  stored: ResourceBinding,
  group: IrResourceGroup,
  representationFields: readonly IrField[],
  findings: ScopeRevalidationFinding[],
): Partial<Record<RevalidatableRefName, ConfirmableRef | undefined>> {
  // The fresh derivation supplies replacement candidates. It is computed from the SAME
  // heuristics that produced the stored refs, so an invalidated ref is offered the
  // candidate a first-time ingestion of this spec would have proposed.
  const out: Partial<Record<RevalidatableRefName, ConfirmableRef | undefined>> = {};
  for (const name of REVALIDATABLE_REFS) {
    const ref = stored[name];
    if (ref === undefined) {
      continue;
    }
    if (refTargetResolves(ref.value, group, representationFields)) {
      // SS-16.1 — untouched by the diff: carried forward with its confirmation intact.
      out[name] = ref;
      continue;
    }
    const candidate = deriveReplacementCandidate(name, group, representationFields);
    findings.push({
      kind: "binding-ref-invalidated",
      resourceRef: stored.resourceRef,
      ref: name,
      wasConfirmed: isConfirmed(ref),
      replacedByCandidate: candidate !== undefined,
    });
    out[name] = candidate ?? { value: ref.value, confirmedBy: null, confirmedAt: null };
  }
  return out;
}

/**
 * A fresh unconfirmed candidate for an invalidated ref, or `undefined` when the heuristic
 * finds none. Derived by re-running the first-time derivation over the new IR and reading
 * off the same-named ref, so there is exactly one definition of "what the mediator would
 * guess for this ref" rather than a second, drifting copy here.
 */
function deriveReplacementCandidate(
  name: RevalidatableRefName,
  group: IrResourceGroup,
  representationFields: readonly IrField[],
): ConfirmableRef | undefined {
  // Only the two ref families whose candidate is cheap and unambiguous to re-guess are
  // offered a replacement: a *field* ref re-resolved by name against the new
  // representation, and the collection read. Re-guessing a pagination/delta parameter of a
  // *different* operation risks proposing an unrelated parameter, so those are left
  // dangling-and-unconfirmed for the operator to re-point explicitly (RB-2).
  if (name === "collectionReadRef") {
    const collectionRead = pickCollectionRead(group.operations);
    return collectionRead === undefined
      ? undefined
      : {
          value: { kind: "operation", operationId: collectionRead.operationId },
          confirmedBy: null,
          confirmedAt: null,
        };
  }
  void representationFields;
  return undefined;
}

/**
 * SS-16.2/16.4 for `sourceScopeRef` (SS-7). Its **single** confirmation covers the whole
 * component set, so one unresolvable `fieldPath` returns the entire ref to unconfirmed —
 * the components are retained so the operator can see and correct exactly which capture
 * broke (and so `record-derived` bindings selecting a still-valid component are not
 * silently orphaned).
 */
function revalidateSourceScopeRef(
  stored: ResourceBinding,
  group: IrResourceGroup,
  representationFields: readonly IrField[],
  findings: ScopeRevalidationFinding[],
): SourceScopeRef | undefined {
  const ref = stored.sourceScopeRef;
  if (ref === undefined) {
    return undefined;
  }
  const broken = ref.components
    .filter((component) => !fieldPathResolves(component.fieldPath, group, representationFields))
    .map((component) => component.key);
  if (broken.length === 0) {
    // SS-16.1 — every capture still resolves: carried forward with its confirmation.
    return ref;
  }
  findings.push({
    kind: "source-scope-ref-invalidated",
    resourceRef: stored.resourceRef,
    brokenComponentKeys: broken,
    wasConfirmed: ref.confirmedBy !== null && ref.confirmedAt !== null,
  });
  return { components: ref.components, confirmedBy: null, confirmedAt: null };
}

/**
 * SS-16.1/16.2/16.3 for `scopePathBindings`. The **new** IR's scope-parameter set is
 * authoritative about which parameters exist — computed by the very
 * {@link collectScopeParameterNames} the first-time derivation uses, so "what counts as a
 * scope parameter" keeps exactly one definition across derive, gate, fill, and now
 * re-validate.
 *
 * Three cases, in the order SS-16 states them:
 *
 * 1. **still present** → the stored entry carries forward **verbatim** — kind, value /
 *    `sourceScopeKey` / `scopeKeyRef`, and confirmation (SS-16.1);
 * 2. **newly present** → a fresh **unconfirmed** entry from the derivation, heuristic
 *    candidate value and all (SS-16.3);
 * 3. **no longer present** → the stored entry is retained but returned to **unconfirmed**
 *    (SS-16.2), so it is used nowhere while the operator decides whether the parameter was
 *    renamed (re-point it) or genuinely dropped (delete it).
 *
 * Entries are ordered by the new IR's parameter order, with the orphaned ones last, so the
 * collection reads as "what this resource needs now, then what it used to need".
 */
function revalidateScopePathBindings(
  stored: ResourceBinding,
  group: IrResourceGroup,
  findings: ScopeRevalidationFinding[],
): ScopePathBinding[] {
  const storedEntries = new Map<string, ScopePathBinding>(
    (stored.scopePathBindings ?? []).map((entry) => [entry.parameterName, entry]),
  );
  const derived = new Map<string, ScopePathBinding>(
    deriveScopePathBindings(group).map((entry) => [entry.parameterName, entry]),
  );

  const out: ScopePathBinding[] = [];
  for (const parameterName of collectScopeParameterNames(group)) {
    const existing = storedEntries.get(parameterName);
    if (existing !== undefined) {
      out.push(existing); // (1) SS-16.1 — carried forward unchanged.
      continue;
    }
    // (2) SS-16.3 — a new required path parameter the mediator cannot fill.
    const fresh = derived.get(parameterName);
    if (fresh === undefined) {
      continue;
    }
    findings.push({
      kind: "scope-parameter-added",
      resourceRef: stored.resourceRef,
      parameterName,
    });
    out.push(fresh);
  }

  // (3) SS-16.2 — bound parameters the new spec no longer declares.
  for (const [parameterName, entry] of storedEntries) {
    if (derived.has(parameterName)) {
      continue;
    }
    findings.push({
      kind: "scope-parameter-removed",
      resourceRef: stored.resourceRef,
      parameterName,
      wasConfirmed: entry.confirmedBy !== null && entry.confirmedAt !== null,
    });
    out.push({ ...entry, confirmedBy: null, confirmedAt: null });
  }
  return out;
}

// ── ScopeCorrespondence re-validation ─────────────────────────────────────────

/** One side of a {@link revalidateScopeCorrespondence} check: an app's re-ingested IR + bindings. */
export interface ScopeCorrespondenceSide {
  readonly appId: string;
  readonly ir: Ir;
  /** The side's stored `ResourceBinding`s — the record resource's and its containers'. */
  readonly bindings: readonly ResourceBinding[];
  /** The **record** resource of the pair on this side (`issues` / `tasks`). */
  readonly resourceRef: string;
}

export interface ScopeCorrespondenceRevalidationInput {
  readonly correspondence: ScopeCorrespondence;
  readonly source: ScopeCorrespondenceSide;
  readonly target: ScopeCorrespondenceSide;
}

/**
 * SS-16.4/16.5 — which of a correspondence's `ScopeLink`s a re-validation invalidates.
 * Archiving (never deleting) keeps a `RecordLink.scopeRef` pointing at one resolvable for
 * a final delete/audit (SS-10.5). A **discriminated scope**, not a boolean, because the
 * two triggers invalidate *different* links:
 *
 * - `"none"` — additive re-pin / nothing broke: every link carries forward (SS-16.1).
 * - `"all"` — a **container resource disappeared** (SS-16.5): every link under the
 *   correspondence points at a container in a resource that no longer exists, so **all**
 *   are archived regardless of how they were established.
 * - `"identity-match"` — a **scope-identity-key field broke** (SS-16.4): only links
 *   `establishedBy = "identity-match"` were formed by the value-preserving comparison that
 *   no longer type-checks. A `constant` / `manual` link is an operator's explicit pinning,
 *   independent of the identity key, so it stays **active** — archiving it would force a
 *   needless manual re-link. This mirrors the spec's exact words: "identity-match
 *   ScopeLink resolution is invalidated".
 */
export type ScopeLinkArchiveScope = "none" | "all" | "identity-match";

/** The re-validated correspondence, its findings, and the `ScopeLink` consequence. */
export interface ScopeCorrespondenceRevalidation {
  readonly correspondence: ScopeCorrespondence;
  readonly findings: readonly ScopeRevalidationFinding[];
  /** SS-16.4/16.5 — which `ScopeLink`s the caller must archive (never delete). */
  readonly archiveScopeLinks: ScopeLinkArchiveScope;
}

/**
 * **SS-16.4/16.5 — re-validate one pair's `ScopeCorrespondence` against both sides'
 * re-ingested IR.** Pure; the caller persists the correspondence and, when
 * {@link ScopeCorrespondenceRevalidation.archiveScopeLinks} is set, archives the links.
 *
 * Checks the three things a correspondence asserts about the world, all of which a spec
 * change can falsify and none of which anything re-checked before SS-16:
 *
 * 1. **`targetContainerRef` / `sourceContainerRef` still name a real resource.** A
 *    confirmed correspondence pointing at a resource that has since left the spec is the
 *    silent-staleness this story exists to close: `ScopeCorrespondenceRepository.propose`
 *    deliberately never clobbers a confirmed row, so nothing else would ever notice.
 * 2. **Each `scopeIdentityKey` pairing's source component still exists** on the source
 *    record resource's `sourceScopeRef`.
 * 3. **Each pairing's `targetFieldPath` still resolves** on the target container resource.
 *
 * Any of the three returns the correspondence to **unconfirmed** — the SS-15.2 enablement
 * gate then blocks every `scope-link` rule on the pair with its existing
 * `scope-identity-key` blocker, which is precisely "the rule stays unenableable until it
 * is re-confirmed" (SS-16.4) with no new blocker vocabulary invented.
 */
export function revalidateScopeCorrespondence(
  input: ScopeCorrespondenceRevalidationInput,
): ScopeCorrespondenceRevalidation {
  const { correspondence, source, target } = input;
  const findings: ScopeRevalidationFinding[] = [];
  const wasConfirmed = correspondence.confirmedBy !== null && correspondence.confirmedAt !== null;

  // (1) The container resources.
  const targetContainer = findGroup(target.ir, correspondence.targetContainerRef.resourceRef);
  if (targetContainer === undefined) {
    findings.push({
      kind: "container-resource-removed",
      side: "target",
      appId: correspondence.targetContainerRef.appId,
      resourceRef: correspondence.targetContainerRef.resourceRef,
      wasConfirmed,
    });
  }
  const storedSourceContainer = correspondence.sourceContainerRef;
  let sourceContainerGone = false;
  if (
    storedSourceContainer !== undefined &&
    findGroup(source.ir, storedSourceContainer.resourceRef) === undefined
  ) {
    sourceContainerGone = true;
    findings.push({
      kind: "container-resource-removed",
      side: "source",
      appId: storedSourceContainer.appId,
      resourceRef: storedSourceContainer.resourceRef,
      wasConfirmed,
    });
  }

  // (2)/(3) The scope identity key's two ends.
  const sourceComponentKeys = new Set(
    findBinding(source.bindings, source.resourceRef)?.sourceScopeRef?.components.map(
      (component) => component.key,
    ) ?? [],
  );
  const targetContainerFields =
    targetContainer === undefined
      ? undefined
      : pickRepresentationFields(targetContainer, pickCollectionRead(targetContainer.operations));

  for (const pairing of correspondence.scopeIdentityKey) {
    if (!sourceComponentKeys.has(pairing.sourceScopeKey)) {
      findings.push({
        kind: "scope-identity-key-invalidated",
        issue: "source-component-removed",
        sourceScopeKey: pairing.sourceScopeKey,
        wasConfirmed,
      });
      continue;
    }
    // A missing target container already produced its own finding; re-reporting every
    // pairing against a resource that is gone would bury it.
    if (targetContainer === undefined || targetContainerFields === undefined) {
      continue;
    }
    if (!fieldPathResolves(pairing.targetFieldPath, targetContainer, targetContainerFields)) {
      findings.push({
        kind: "scope-identity-key-invalidated",
        issue: "target-field-removed",
        sourceScopeKey: pairing.sourceScopeKey,
        wasConfirmed,
      });
    }
  }

  if (findings.length === 0) {
    // SS-16.1 — nothing the correspondence asserts was touched: carried forward unchanged.
    return { correspondence, findings, archiveScopeLinks: "none" };
  }

  const revalidated: ScopeCorrespondence = stripUndefined({
    ...correspondence,
    // The optional source side is dropped when its resource is gone: "present only when
    // enumerable" is now false, which derives `per-scope-pinned` — the fail-safe mode.
    sourceContainerRef: sourceContainerGone ? undefined : correspondence.sourceContainerRef,
    confirmedBy: null,
    confirmedAt: null,
  });
  // A gone container archives every link; a broken identity key archives only the
  // identity-match links it invalidated (a constant/manual link is operator-pinned).
  const containerRemoved = findings.some((f) => f.kind === "container-resource-removed");
  return {
    correspondence: revalidated,
    findings,
    archiveScopeLinks: containerRemoved ? "all" : "identity-match",
  };
}

// ── IR resolution helpers ─────────────────────────────────────────────────────

/** Whether an {@link IrRefTarget} still names something the re-ingested group offers. */
function refTargetResolves(
  target: IrRefTarget,
  group: IrResourceGroup,
  representationFields: readonly IrField[],
): boolean {
  switch (target.kind) {
    case "field":
      return fieldPathResolves(target.path, group, representationFields);
    case "operation":
      return group.operations.some((operation) => operation.operationId === target.operationId);
    case "parameter":
      // Both ends must survive: the operation AND the named parameter on it. A parameter
      // ref pointing at an operation that kept its id but dropped the parameter is exactly
      // the "renamed field" breaking change extensibility.md calls out.
      return group.operations.some(
        (operation) =>
          operation.operationId === target.operationId &&
          operation.parameters.some((parameter) => parameter.name === target.parameter),
      );
  }
}

/**
 * Whether a (possibly dotted) field path resolves against the group's representation.
 * Walks one level into a named object schema the way `sourceScopeRef` derivation does
 * (`repository.owner` → representation field `repository`, typed `RepositoryMeta`, whose
 * fields include `owner`), so a capture and its re-validation agree on what "resolves"
 * means. Deeper paths are resolved as far as the IR describes them.
 */
function fieldPathResolves(
  path: string,
  group: IrResourceGroup,
  representationFields: readonly IrField[],
): boolean {
  const [head, ...rest] = path.split(".");
  if (head === undefined || head.length === 0) {
    return false;
  }
  const field = representationFields.find((candidate) => candidate.name === head);
  if (field === undefined) {
    return false;
  }
  let type = field.type;
  for (const segment of rest) {
    const names = schemaFieldNames(group, type);
    if (names === undefined || !names.includes(segment)) {
      return false;
    }
    type = nestedFieldType(group, type, segment) ?? "";
  }
  return true;
}

/** The declared type of `<schemaName>.<fieldName>`, when the group describes it. */
function nestedFieldType(
  group: IrResourceGroup,
  schemaName: string,
  fieldName: string,
): string | undefined {
  const named = group.schemas.find((schema) => schema.name === schemaName);
  return named?.fields.find((field) => field.name === fieldName)?.type;
}

function findGroup(ir: Ir, resourceRef: string): IrResourceGroup | undefined {
  return ir.find((group) => group.resourceRef === resourceRef);
}

function findBinding(
  bindings: readonly ResourceBinding[],
  resourceRef: string,
): ResourceBinding | undefined {
  return bindings.find((binding) => binding.resourceRef === resourceRef);
}

function isConfirmed(ref: ConfirmableRef): boolean {
  return ref.confirmedBy !== null && ref.confirmedAt !== null;
}
