import type {
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  Ir,
  IrField,
  IrOperation,
  IrRefTarget,
  IrResourceGroup,
  OperationMapping,
  ResourceBinding,
  ScopeContainerRef,
  ScopeCorrespondence,
  ScopeIdentityKey,
  ScopeIdentityKeyPairing,
  ScopePathBinding,
  ScopeTransform,
} from "@mediator/domain";
import { isValuePreservingScopeTransform, scopeCorrespondenceSchema } from "@mediator/domain";
import {
  findMappedTargetOperation,
  scopeParamNamesOf,
  writeRecordIdPathParam,
} from "@mediator/outbound";

import {
  canonicalResourcePairRef,
  deriveDirectionalResourcePairs,
  resourceRefOf,
} from "./artifact-instantiation/derive.js";
import { responseRepresentationFields } from "./resource-bindings.js";
import { loadContainerBinding, type ContainerBindingRepos } from "./sync/scope-requirements.js";

/**
 * **SS-18 — the L3 authoring / derivation entry point.** SS-10..SS-17 built the whole
 * Layer-3 *mechanism* (domain, establishment, resolver, per-scope poll, scoped identity,
 * gate, live enumeration, confirm/link UI) but nothing **configured** it: there was no
 * production writer of `ScopeCorrespondence`, so the SS-15.4 confirm handler 404'd and
 * `scope-link` stayed a disabled option in the SS-9 kind selector. This module is the
 * missing **proposal** half of SS-10.2's "derive-then-confirm", and nothing more:
 *
 *  - {@link deriveScopeCorrespondenceProposal} — the **pure** derivation (SS-18.1/2/3):
 *    detect a scoped resource pair, derive its container refs, and propose a candidate
 *    scope identity key by name/type similarity.
 *  - {@link proposeScopeCorrespondences} — the orchestration the `MappingApproved`
 *    artifact-instantiation path drives (SS-18.1), idempotent by construction (SS-18.6).
 *  - {@link deriveScopeKeyRefCandidate} — the derived `scopeKeyRef` the SS-18.4 kind
 *    selector offers when an operator picks `scope-link`.
 *
 * **Nothing here confirms anything** (SS-18.3/18.8). Every artifact it proposes is
 * created with `confirmedBy`/`confirmedAt` **null**; the SS-15.4 panel remains the sole
 * writer of a `ScopeCorrespondence`'s confirmation pair, and an operator's explicit
 * confirm remains the sole writer of a `scope-link` binding's. It coins no new domain
 * term and needs **no migration** — `scope_correspondence` already exists.
 */

// ── Container-resource + identity-key heuristics (implementation-defined) ─────

/**
 * Field names that identify a **container** record, used both to find the container
 * resource and to score identity-key candidates. Mirrors (and deliberately overlaps)
 * `packages/ir`'s `CONTAINER_IDENTITY_PART_NAMES` — the same conservative vocabulary
 * SS-7 derives a `sourceScopeRef` with, so the two ends of a pairing speak one language.
 */
const CONTAINER_IDENTITY_FIELD_NAMES = [
  "name",
  "title",
  "slug",
  "identifier",
  "key",
  "owner",
  "namespace",
  "label",
];

/**
 * Synonym groups for identity-field **name similarity**. Two names in the same group are
 * near-equivalent ways of naming the same container property, which is exactly the
 * SS-18.3 example (source `name` ↔ target `title`). Implementation-defined and
 * deliberately small: a wrong guess is operator-correctable in the SS-15.4 panel, whereas
 * an over-eager one would propose a nonsense pairing. Compared after {@link normalizeName}.
 */
const NAME_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["name", "title", "label", "displayname"],
  ["owner", "username", "login", "user", "author"],
  ["slug", "identifier", "key", "code"],
  ["namespace", "org", "organization", "group", "team", "workspace"],
];

/**
 * Lowercased, separator-free, id-suffix-free form of a field/component name.
 *
 * The id suffix is only stripped at a **word boundary** — a `_id`/`-id` separator or a
 * camelCase `…Id` — never from the raw lowercased string. Stripping unconditionally would
 * maul ordinary words that merely end in those two letters (`grid -> gr`, `uuid -> uu`,
 * `valid -> val`, `hybrid -> hybr`), which then match nothing (or, worse, something else)
 * in {@link namesMatch} and {@link scoreFieldSimilarity}. So the boundary is detected on
 * the ORIGINAL name, before separators are compacted away.
 */
function normalizeName(name: string): string {
  // A separator-delimited `…_id` / `…-id` (any case), or a camelCase `…Id`. A bare
  // trailing "id" with no boundary is part of the word (`grid`, `uuid`, `valid`) — and a
  // field literally named `id` keeps its name, which is what it means.
  const hasIdBoundary = /[_\-. ]id$/i.test(name) || /[a-z0-9]Id$/.test(name);
  const trimmed = hasIdBoundary ? name.slice(0, -2).replace(/[_\-. ]$/, "") : name;
  return trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The leaf segment of a dotted IR field path (`repository.owner` -> `owner`). */
function leafSegment(path: string): string {
  const segments = path.split(".");
  return segments[segments.length - 1] ?? path;
}

/** The head segment of a dotted IR field path (`repository.owner` -> `repository`). */
function headSegment(path: string): string {
  const segments = path.split(".");
  return segments[0] ?? path;
}

/**
 * Abbreviation pairs for **container nouns**, where a record field and the resource that
 * serves it are named differently rather than merely inflected — the scenario-1 case is
 * Gitea, whose issue records carry a `repository` object while the resource that lists
 * repositories is `repos`. Deliberately an explicit, tiny list rather than generic prefix
 * matching: `name` is a prefix of `namespace` too, and pairing a scope component with the
 * wrong container resource would route writes to the wrong container — precisely what
 * Layer 3 exists to prevent. Compared over {@link singularCandidates}.
 */
const CONTAINER_NOUN_ABBREVIATIONS: readonly (readonly string[])[] = [
  ["repo", "repository"],
  ["org", "organization"],
  ["ns", "namespace"],
];

/**
 * The plausible singular forms of a (already {@link normalizeName}d) noun, as a **candidate
 * set** rather than one committed answer. English pluralization is ambiguous read backwards
 * — `-es` strips correctly for `boxes -> box` but wrongly for `issues -> issu` — so
 * committing to the first applicable strip silently breaks the most common shape of all
 * (`issues`, `pages`, `spaces`, `files`, `releases`, `milestones`: a noun ending in `e`,
 * pluralized with a bare `-s`). Emitting every candidate and matching if **any** coincides
 * costs nothing and cannot pick the wrong one.
 *
 * Candidates: the word itself (already singular), minus `-s`, minus `-es`, and the
 * `-ies -> -y` form (`repositories -> repository`).
 */
function singularCandidates(value: string): readonly string[] {
  const candidates = new Set<string>([value]);
  if (value.endsWith("ies") && value.length > 3) {
    candidates.add(`${value.slice(0, -3)}y`);
  }
  if (value.endsWith("es") && value.length > 2) {
    candidates.add(value.slice(0, -2));
  }
  if (value.endsWith("s") && value.length > 1) {
    candidates.add(value.slice(0, -1));
  }
  return [...candidates];
}

/**
 * Whether two resource/field names denote the same thing up to trivial singular/plural
 * variation (`project` ~ `projects`, `issues` ~ `issue`, `repositories` ~ `repository`) or
 * a known container-noun abbreviation (`repos` ~ `repository`, via
 * {@link CONTAINER_NOUN_ABBREVIATIONS}). Both sides are reduced to their
 * {@link singularCandidates} set and matched if the sets intersect — so neither side has to
 * guess which strip its counterpart used.
 *
 * Exported because it is the single definition of "these two nouns name the same resource",
 * relied on by both container derivations **and** the per-parameter `scopeKeyRef` pairing —
 * a false negative here silently costs a whole proposal (and with it, L3 configurability),
 * so it is worth pinning directly.
 */
export function namesMatch(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === right) {
    return true;
  }
  const leftCandidates = singularCandidates(left);
  const rightCandidates = singularCandidates(right);
  if (leftCandidates.some((candidate) => rightCandidates.includes(candidate))) {
    return true;
  }
  return CONTAINER_NOUN_ABBREVIATIONS.some(
    (group) =>
      leftCandidates.some((candidate) => group.includes(candidate)) &&
      rightCandidates.some((candidate) => group.includes(candidate)),
  );
}

// ── The proposal (SS-18.1 / 18.2 / 18.3) ─────────────────────────────────────

/** One side of a resource pair, with everything the derivation reads about it. */
export interface ScopeAuthoringSide {
  readonly appId: string;
  /** The side's spec IR (its resource groups). */
  readonly ir: Ir;
  /** The **record** resource of the pair on this side (`issues` / `tasks`). */
  readonly resourceRef: string;
  /** Every `ResourceBinding` of the side's spec — the record resource's and its containers'. */
  readonly bindings: readonly ResourceBinding[];
}

export interface ScopeCorrespondenceProposalInput {
  readonly resourcePairRef: string;
  readonly source: ScopeAuthoringSide;
  readonly target: ScopeAuthoringSide;
  /** The `OperationMapping`s covering **this** resource pair (already filtered). */
  readonly operationMappings: readonly OperationMapping[];
  readonly newId: () => string;
}

/**
 * Why a pair yielded no proposal — returned instead of a bare `undefined` so a caller
 * (and a test) can tell "correctly not scoped" apart from "scoped but underivable", and
 * so a future SS-16 lifecycle pass can surface the latter to an operator.
 */
export type ScopeProposalSkipReason =
  /** The pair's target write ops carry no unsatisfied container path parameter (SS-18.1). */
  | "not-scoped"
  /** The target container path parameter resolves to no IR resource with a native id (SS-18.2). */
  | "target-container-unresolved"
  /** The source resource captures no container identity, so no pairing can be derived (SS-18.3). */
  | "no-source-scope-capture"
  /** No source component paired to any target container field value-preservingly (SS-18.3). */
  | "no-value-preserving-pairing";

export type ScopeCorrespondenceProposal =
  | { readonly kind: "proposed"; readonly correspondence: ScopeCorrespondence }
  | { readonly kind: "skipped"; readonly reason: ScopeProposalSkipReason };

/**
 * **SS-18.1/18.2/18.3 — derive one pair's proposed `ScopeCorrespondence`.** Pure: no
 * I/O, no persistence, so the whole detection + derivation is unit-testable against IR
 * fixtures. The caller persists the result through {@link ScopeCorrespondenceProposer}.
 *
 * ## Is the pair scoped? (SS-18.1)
 *
 * The approved **target write operation** must carry a **container path parameter** — a
 * scope path parameter that is not the record id. That classification is **not**
 * re-implemented here: it reuses the very helpers the SS-4 resolver and the SS-5/SS-9
 * enablement gate use ({@link findMappedTargetOperation}, {@link writeRecordIdPathParam},
 * {@link scopeParamNamesOf}), so "what the mediator considers a container parameter"
 * has exactly one definition across derive, gate, and fill.
 *
 * A container parameter is then **discounted** when the target binding already satisfies
 * it with a **confirmed** `constant` (an L1 single container) or a **confirmed**
 * `record-derived` entry (an L2 shared value-space) — the two non-L3 fill sources
 * SS-18.1 names. An **unconfirmed** entry (including SS-2's derived `constant` default)
 * satisfies nothing, so it still counts: the proposal is what *makes* `scope-link`
 * selectable, and it must not require the operator to have chosen L3 first. Proposing
 * costs nothing — the correspondence is unconfirmed and the selector merely gains an
 * option; the operator remains free to confirm the parameter as an L1 `constant` instead.
 *
 * With no unsatisfied container parameter the pair is **not scoped** and nothing is
 * created (`skipped: "not-scoped"`) — the SS-18 out-of-scope rule.
 *
 * ## The container resources (SS-18.2)
 *
 * `targetContainerRef` is the IR resource whose **native id addresses** the container
 * path parameter: the parameter's position in the write path names it (Vikunja
 * `PUT /projects/{id}/tasks` -> the segment before `{id}` is `projects`), with the
 * parameter's own name as a fallback (`project_id` -> `projects`). The candidate must
 * additionally carry a `nativeIdRef` — without a native id it cannot address anything.
 *
 * `sourceContainerRef` is the IR resource whose identity the source's `sourceScopeRef`
 * components address (Gitea `repository.owner`/`repository.name` -> `repos`), and is
 * **absent unless that resource is enumerable** — i.e. unless its own `ResourceBinding`
 * carries a `collectionReadRef` (present, confirmed or not; SS-18.5 surfaces it as an
 * ordinary RB-3 row for the operator to confirm and the SS-15.2 gate to block on).
 * That absence is load-bearing: it is exactly what makes `derivePollScopeMode` derive
 * `per-scope-pinned` rather than `per-scope-enumerated` (SS-13.5), so scenario-1's
 * trimmed Gitea spec (no repo-list) correctly derives as pinned.
 *
 * ## The candidate scope identity key (SS-18.3)
 *
 * Each source `sourceScopeRef` component is paired to the target container field of
 * closest **name/type similarity** ({@link scoreFieldSimilarity}), restricted to
 * **value-preserving** pairings — the shared {@link isValuePreservingScopeTransform}
 * rule, reused rather than restated. The result is **proposed, never confirmed**: the
 * correspondence is built with `confirmedBy`/`confirmedAt` null and the SS-15.4 panel
 * stays the only writer of those two columns.
 */
export function deriveScopeCorrespondenceProposal(
  input: ScopeCorrespondenceProposalInput,
): ScopeCorrespondenceProposal {
  const { source, target } = input;

  const targetGroup = findGroup(target.ir, target.resourceRef);
  if (targetGroup === undefined) {
    return { kind: "skipped", reason: "not-scoped" };
  }
  const targetBinding = findBinding(target.bindings, target.resourceRef);

  // SS-18.1 — the container path parameter(s) of the approved target write operations.
  const containerParams = unsatisfiedContainerPathParams(
    input.operationMappings,
    targetGroup,
    targetBinding,
  );
  const containerParam = containerParams[0];
  if (containerParam === undefined) {
    return { kind: "skipped", reason: "not-scoped" };
  }

  // SS-18.2 — the target container resource, addressed by its native id.
  const targetContainer = deriveTargetContainer(target, containerParam);
  if (targetContainer === undefined) {
    return { kind: "skipped", reason: "target-container-unresolved" };
  }

  // SS-18.3 — the candidate scope identity key, from the source's captured scope.
  const sourceBinding = findBinding(source.bindings, source.resourceRef);
  const sourceComponents = sourceBinding?.sourceScopeRef?.components ?? [];
  if (sourceComponents.length === 0) {
    return { kind: "skipped", reason: "no-source-scope-capture" };
  }
  const scopeIdentityKey = deriveCandidateScopeIdentityKey(
    sourceComponents,
    containerRepresentationFields(targetContainer.group),
  );
  if (scopeIdentityKey === undefined) {
    return { kind: "skipped", reason: "no-value-preserving-pairing" };
  }

  // SS-18.2 — the source container resource, present only when enumerable.
  const sourceContainerRef = deriveSourceContainerRef(source, sourceComponents);

  const correspondence = scopeCorrespondenceSchema.parse({
    id: input.newId(),
    resourcePairRef: input.resourcePairRef,
    scopeIdentityKey,
    targetContainerRef: { appId: target.appId, resourceRef: targetContainer.group.resourceRef },
    ...(sourceContainerRef !== undefined ? { sourceContainerRef } : {}),
    // SS-18.1 / 18.8 — proposed, never auto-confirmed.
    confirmedBy: null,
    confirmedAt: null,
  });
  return { kind: "proposed", correspondence };
}

/** A container path parameter of an approved target write op, plus the op that carries it. */
interface ContainerPathParam {
  readonly parameterName: string;
  readonly operation: IrOperation;
}

/**
 * The container path parameters of the pair's approved target **write** operations that
 * are **not** already satisfied by a confirmed `constant` / `record-derived` binding
 * (SS-18.1). Read operations are excluded: SS-18.1 keys the detection to the *write*
 * side, which is where a container must be addressed to create/update/delete a record.
 */
function unsatisfiedContainerPathParams(
  operationMappings: readonly OperationMapping[],
  targetGroup: IrResourceGroup,
  targetBinding: ResourceBinding | undefined,
): readonly ContainerPathParam[] {
  const found: ContainerPathParam[] = [];
  const seen = new Set<string>();
  const entries = targetBinding?.scopePathBindings ?? [];
  for (const operationMapping of operationMappings) {
    const action = operationMapping.action;
    if (action !== "create" && action !== "update" && action !== "delete") {
      continue;
    }
    const operation = findMappedTargetOperation(operationMapping, targetGroup);
    if (operation === undefined) {
      continue;
    }
    // The SS-4 record-id determination, reused verbatim: a create carries no
    // `targetIdParamRef`, so all its path params are scope (Vikunja `PUT /projects/{id}/tasks`).
    const recordIdParam = writeRecordIdPathParam(operationMapping, operation);
    for (const parameterName of scopeParamNamesOf(operation, recordIdParam)) {
      if (seen.has(parameterName) || isSatisfiedByNonScopeLinkKind(entries, parameterName)) {
        continue;
      }
      seen.add(parameterName);
      found.push({ parameterName, operation });
    }
  }
  return found;
}

/**
 * Whether a scope parameter is already satisfied by a **confirmed** non-L3 fill source —
 * an L1 single `constant` container or an L2 `record-derived` shared value-space. An
 * unconfirmed entry satisfies nothing (it is used nowhere), and a `scope-link` entry is
 * the L3 case itself, so neither discounts the parameter.
 */
function isSatisfiedByNonScopeLinkKind(
  entries: readonly ScopePathBinding[],
  parameterName: string,
): boolean {
  return entries.some(
    (entry) =>
      entry.parameterName === parameterName &&
      (entry.kind === "constant" || entry.kind === "record-derived") &&
      entry.confirmedBy !== null &&
      entry.confirmedAt !== null,
  );
}

/** The resolved target container resource: its IR group and the binding that gives it a native id. */
interface ResolvedContainer {
  readonly group: IrResourceGroup;
  readonly binding: ResourceBinding;
}

/**
 * The target container resource (SS-18.2) — the IR resource whose **native id addresses**
 * the container path parameter. Candidate names, in confidence order:
 *
 * 1. the path segment immediately **preceding** the parameter in the write op's path
 *    (`PUT /projects/{id}/tasks` -> `projects`) — the parameter's position in the URL
 *    hierarchy *is* the container it addresses, which is the strongest available signal;
 * 2. the parameter's own name with any id suffix stripped (`project_id` -> `project`) —
 *    the fallback for a container parameter that is not path-positioned after its noun.
 *
 * A candidate only resolves when the named IR group has a `ResourceBinding` carrying a
 * `nativeIdRef`: a resource with no native id cannot address anything, so guessing it
 * would produce a correspondence that can never establish a `ScopeLink`.
 */
function deriveTargetContainer(
  target: ScopeAuthoringSide,
  containerParam: ContainerPathParam,
): ResolvedContainer | undefined {
  const candidates = [
    segmentPrecedingParameter(containerParam.operation.path, containerParam.parameterName),
    containerParam.parameterName,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    const group = target.ir.find(
      (entry) =>
        entry.resourceRef !== target.resourceRef && namesMatch(entry.resourceRef, candidate),
    );
    if (group === undefined) {
      continue;
    }
    const binding = findBinding(target.bindings, group.resourceRef);
    if (binding?.nativeIdRef === undefined) {
      continue;
    }
    return { group, binding };
  }
  return undefined;
}

/** The literal path segment immediately before `{parameterName}`, if the path has one. */
function segmentPrecedingParameter(path: string, parameterName: string): string | undefined {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const index = segments.indexOf(`{${parameterName}}`);
  if (index <= 0) {
    return undefined;
  }
  const previous = segments[index - 1];
  return previous !== undefined && !previous.startsWith("{") ? previous : undefined;
}

/**
 * The source container resource ref (SS-18.2), or **absent** when the source container is
 * not enumerable. Candidate names come from the source's `sourceScopeRef`: a nested
 * component's **head** segment names the container object (`repository.owner` ->
 * `repository`), and a flat `<container>_id` component's key names it directly
 * (`project_id` -> component key `project`).
 *
 * The candidate must resolve to an IR group whose `ResourceBinding` carries a
 * `collectionReadRef` — the container **list** operation SS-11 discovery and SS-17
 * enumeration consume. Presence (not confirmation) is the test: SS-18.5 surfaces that ref
 * as an ordinary RB-3 row precisely so the operator confirms it and the SS-15.2 gate
 * blocks until they do. When nothing resolves, the ref is omitted — and that omission is
 * what makes the rule derive `per-scope-pinned` (SS-13.4/13.5).
 */
function deriveSourceContainerRef(
  source: ScopeAuthoringSide,
  components: readonly { readonly key: string; readonly fieldPath: string }[],
): ScopeContainerRef | undefined {
  const candidates: string[] = [];
  for (const component of components) {
    const head = headSegment(component.fieldPath);
    if (head !== component.fieldPath) {
      candidates.push(head);
    }
    candidates.push(component.key);
  }
  for (const candidate of candidates) {
    const group = source.ir.find(
      (entry) =>
        entry.resourceRef !== source.resourceRef && namesMatch(entry.resourceRef, candidate),
    );
    if (group === undefined) {
      continue;
    }
    const binding = findBinding(source.bindings, group.resourceRef);
    if (binding?.collectionReadRef === undefined) {
      // Present but not enumerable -> the SS-13.4 pinned case; keep looking for another
      // candidate, and if none is enumerable leave the ref absent.
      continue;
    }
    return { appId: source.appId, resourceRef: group.resourceRef };
  }
  return undefined;
}

/**
 * The candidate scope identity key (SS-18.3): each source `sourceScopeRef` component
 * paired to the target container field of closest name/type similarity, keeping only
 * **value-preserving** pairings ({@link isProposableScopeIdentityPairing}). Each target
 * field is claimed at most once (two source components must not collapse onto one target
 * field — the pair would then match every container equally). `undefined` when no source
 * component pairs at all, so a correspondence is never proposed with an empty key.
 */
function deriveCandidateScopeIdentityKey(
  components: readonly { readonly key: string; readonly fieldPath: string }[],
  targetFields: readonly IrField[],
): ScopeIdentityKey | undefined {
  const pairings: ScopeIdentityKeyPairing[] = [];
  const claimed = new Set<string>();
  for (const component of components) {
    const match = bestTargetField(component, targetFields, claimed);
    if (match === undefined) {
      continue;
    }
    const pairing = buildPairing(component.key, match.name);
    // SS-18.3 — the shared value-preserving rule decides; a value-altering candidate is
    // never proposed (defence in depth: `scopeIdentityKeyPairingSchema` rejects one too).
    if (!isProposableScopeIdentityPairing(pairing)) {
      continue;
    }
    claimed.add(match.name);
    pairings.push(pairing);
  }
  return pairings.length > 0 ? pairings : undefined;
}

/**
 * Whether a candidate pairing may be **proposed**: it must be value-preserving, i.e.
 * carry no transform at all or a `rename` one. Delegates to the single shared
 * {@link isValuePreservingScopeTransform} definition — the same rule
 * `scopeIdentityKeyPairingSchema`, the `record-derived` scope binding, and the identity
 * `FieldMapping` (AS-5) all use — rather than restating "rename only" a fourth time.
 * Exported so the derivation's central restriction is directly testable.
 */
export function isProposableScopeIdentityPairing(pairing: ScopeIdentityKeyPairing): boolean {
  return pairing.transform === undefined || isValuePreservingScopeTransform(pairing.transform);
}

/**
 * Build one pairing. A pairing whose two ends carry **different** names is a `rename` —
 * the one value-preserving transform kind (source `name` -> target `title` passes the
 * value through unchanged). Identical names need no transform at all.
 */
function buildPairing(sourceScopeKey: string, targetFieldPath: string): ScopeIdentityKeyPairing {
  const rename: ScopeTransform = { kind: "rename" };
  return normalizeName(sourceScopeKey) === normalizeName(leafSegment(targetFieldPath))
    ? { sourceScopeKey, targetFieldPath }
    : { sourceScopeKey, targetFieldPath, transform: rename };
}

/**
 * The unclaimed target container field of closest similarity to a source scope component,
 * or `undefined` when nothing scores above zero (no guess is better than a wrong one —
 * the operator can add the pairing in the SS-15.4 panel).
 */
function bestTargetField(
  component: { readonly key: string; readonly fieldPath: string },
  targetFields: readonly IrField[],
  claimed: ReadonlySet<string>,
): IrField | undefined {
  let best: IrField | undefined;
  let bestScore = 0;
  for (const field of targetFields) {
    if (claimed.has(field.name)) {
      continue;
    }
    const score = scoreFieldSimilarity(component, field);
    if (score > bestScore) {
      best = field;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The **name/type similarity** score of a source scope component against a target
 * container field (SS-18.3). Higher is closer; `0` means "no pairing". Name similarity
 * dominates (it is the signal SS-18.3 names), with a small type-compatibility bonus as
 * the tiebreak between two equally-named candidates:
 *
 * - `100` exact — the normalized names are equal (`name` ~ `name`, `project_id` ~ `project`);
 * - ` 70` synonym — both sit in one {@link NAME_SYNONYM_GROUPS} group (`name` ~ `title`);
 * - ` 40` containment — one normalized name contains the other (`owner` ~ `ownerLogin`),
 *   but only when the target field is a plausible container-identity field, so a stray
 *   `description` never pairs;
 * - `  0` otherwise.
 *
 * A **scalar** target field scores `+5`: a container identity value must round-trip as a
 * single comparable value, so an object/array-typed field is a poorer match than a
 * string/number one of the same name. It cannot promote a `0` — an unrelated field is
 * never paired just for being a string.
 */
function scoreFieldSimilarity(
  component: { readonly key: string; readonly fieldPath: string },
  field: IrField,
): number {
  const sourceName = normalizeName(component.key);
  const targetName = normalizeName(field.name);
  const base =
    sourceName === targetName
      ? 100
      : shareSynonymGroup(sourceName, targetName)
        ? 70
        : isIdentityFieldName(field.name) &&
            (sourceName.includes(targetName) || targetName.includes(sourceName))
          ? 40
          : 0;
  if (base === 0) {
    return 0;
  }
  return base + (isScalarType(field.type) ? 5 : 0);
}

function shareSynonymGroup(a: string, b: string): boolean {
  return NAME_SYNONYM_GROUPS.some((group) => group.includes(a) && group.includes(b));
}

function isIdentityFieldName(name: string): boolean {
  const normalized = normalizeName(name);
  return CONTAINER_IDENTITY_FIELD_NAMES.some(
    (candidate) => normalizeName(candidate) === normalized,
  );
}

/** Whether an IR type names a single comparable value rather than an object/array. */
function isScalarType(type: string): boolean {
  if (type.endsWith("[]")) {
    return false;
  }
  return ["string", "number", "integer", "boolean"].includes(type.toLowerCase());
}

/**
 * The fields of a container resource's record representation — what a scope identity
 * key's `targetFieldPath` may point at. Reuses the SS-7 confirm path's
 * {@link responseRepresentationFields} (the union of the group's response schemas, falling
 * back to its declared schemas) so a proposed `targetFieldPath` is validated against the
 * **same** field set the operator's correction would be.
 */
function containerRepresentationFields(group: IrResourceGroup): readonly IrField[] {
  return responseRepresentationFields(group);
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

// ── The derived `scopeKeyRef` for a `scope-link` binding (SS-18.4) ────────────

/**
 * **SS-18.4 — the derived `scopeKeyRef`, PER SCOPE PARAMETER**: which component of that
 * side's `ScopeLink.appXScopeKey` map addresses each of this resource's scope path
 * parameters. Returns a `{ parameterName -> component }` map; a parameter with no
 * confident derivation is simply **absent** from it and the operator supplies the key by
 * hand.
 *
 * Pure, and deliberately mirrors how SS-11 discovery *builds* each side's scope key, so a
 * derived ref resolves against a real established link rather than a plausible-looking name:
 *
 * - the **target** side's scope key is `{ [<container nativeIdRef leaf>]: <native id> }` —
 *   `scope-discovery.ts` builds it with exactly **one** entry, so every target-side scope
 *   parameter legitimately reads that same component;
 * - the **source** side's scope key is the record's *captured scope*
 *   (`scopeKeyFromCaptured`), whose keys are the source resource's own `sourceScopeRef`
 *   component keys — so a parameter is matched to the component that **names** it
 *   ({@link namesMatch}: `{owner}` -> `owner`, `{repo}` -> `repo`).
 *
 * ## Why the source side is matched per parameter, and never defaulted
 *
 * A multi-part source container (Gitea's `{owner}` + `{repo}`) has one component per
 * parameter, and filling the wrong one is **not** a loud failure: `alice/alice` is a
 * perfectly valid repository path, so a mis-derived key can address a real-but-wrong
 * container instead of erroring. Every branch below therefore withholds rather than
 * guesses — the same fail-safe discipline the multi-correspondence case uses:
 *
 * - **no component names the parameter** -> nothing offered for it;
 * - **several components name it** -> nothing offered. Two components can legitimately
 *   match one parameter (`namesMatch` treats `org`/`organization` and `repo`/`repository`
 *   as one noun, and SS-7 lets an operator key components freely), and picking the first
 *   would make the answer depend on array order — `[organization, org]` and
 *   `[org, organization]` must not disagree about `{org}`;
 * - **exactly one component AND exactly one scope parameter** -> paired regardless of the
 *   names, since there is then exactly one possible container key and one slot to fill.
 *   Both halves of that condition are load-bearing: a source that captures one component
 *   but polls a two-segment path (`GET /repos/{owner}/{repo}/issues`) cannot fill both
 *   parameters from it, and spreading the one component across both is the same
 *   wrong-container hazard.
 */
export function deriveScopeKeyRefCandidates(input: {
  readonly correspondence: ScopeCorrespondence;
  /** The app owning the `ResourceBinding` whose scope parameters are being authored. */
  readonly appId: string;
  /** That binding itself — its `sourceScopeRef` keys the source-side scope key. */
  readonly binding: ResourceBinding;
  /** The `ResourceBinding` of `correspondence.targetContainerRef`'s resource, if resolved. */
  readonly targetContainerBinding: ResourceBinding | undefined;
}): Readonly<Record<string, string>> {
  const { correspondence, appId, binding, targetContainerBinding } = input;
  const parameterNames = (binding.scopePathBindings ?? []).map((entry) => entry.parameterName);
  const candidates: Record<string, string> = {};

  // The target side is checked first: SS-18.4 is written about the target `appXScopeKey`,
  // and a self-pair (same app both sides) is refused by rule resolution anyway.
  if (correspondence.targetContainerRef.appId === appId) {
    const path = fieldPathOf(targetContainerBinding?.nativeIdRef?.value);
    const component = path === undefined ? undefined : leafSegment(path);
    if (component !== undefined) {
      for (const parameterName of parameterNames) {
        candidates[parameterName] = component;
      }
    }
    return candidates;
  }

  if (correspondence.sourceContainerRef?.appId === appId) {
    const components = binding.sourceScopeRef?.components ?? [];
    // The single-component fallback holds ONLY when the resource also has exactly one
    // scope parameter. With more parameters than components the captured scope cannot fill
    // them all, and spreading the one component across every parameter is the
    // wrong-container hazard again: a source capturing only `repo` but polling
    // `GET /repos/{owner}/{repo}/issues` would pre-fill `{owner}` from the repo component.
    const soleComponent =
      components.length === 1 && parameterNames.length === 1 ? components[0] : undefined;
    for (const parameterName of parameterNames) {
      // `filter`, not `find`: two components can legitimately match one parameter now that
      // `namesMatch` treats `org`/`organization` and `repo`/`repository` as one noun, and
      // SS-7 lets an operator key components freely. Picking the first would make the
      // answer depend on array order, so an ambiguous match is withheld instead — the same
      // fail-safe as the multi-correspondence case.
      const matches = components.filter((component) => namesMatch(component.key, parameterName));
      const component = matches.length === 1 ? matches[0] : soleComponent;
      if (component !== undefined) {
        candidates[parameterName] = component.key;
      }
    }
  }
  return candidates;
}

/** The field path an `IrRefTarget` names, when it is a `field` target. */
function fieldPathOf(target: IrRefTarget | undefined): string | undefined {
  return target?.kind === "field" ? target.path : undefined;
}

// ── Orchestration: propose for a `MappingApproved` (SS-18.1 / 18.6) ───────────

/** Reads one `ApiSpec` (its IR + owning app) — the real `ApiSpecRepository` satisfies it. */
export interface ScopeAuthoringSpecReader {
  getById(id: string): Promise<ApiSpec | undefined>;
}

/** Reads a spec's `ResourceBinding`s — the real `ResourceBindingRepository` satisfies it. */
export interface ScopeAuthoringBindingReader {
  listByApiSpecId(apiSpecId: string): Promise<ResourceBinding[]>;
}

/**
 * Persists a proposal idempotently — the real `ScopeCorrespondenceRepository.propose`
 * satisfies it: never a duplicate, never clobbering a confirmed row, refreshing an
 * unconfirmed candidate (SS-18.6). A fake **must** mirror those three semantics.
 */
export interface ScopeCorrespondenceProposer {
  propose(candidate: ScopeCorrespondence): Promise<ScopeCorrespondence>;
}

export interface ScopeCorrespondenceProposalOps {
  readonly specs: ScopeAuthoringSpecReader;
  readonly bindings: ScopeAuthoringBindingReader;
  readonly correspondences: ScopeCorrespondenceProposer;
}

/** One pair that yielded no proposal, and why (SS-18.1's negative cases). */
export interface SkippedScopePair {
  readonly resourcePairRef: string;
  readonly reason: ScopeProposalSkipReason;
}

/** The outcome of a proposal run: what was stored, and what was skipped and why. */
export interface ScopeProposalOutcome {
  readonly proposed: readonly ScopeCorrespondence[];
  readonly skipped: readonly SkippedScopePair[];
}

export interface ProposeScopeCorrespondencesInput {
  readonly mapping: ApprovedMapping;
  readonly fields: readonly FieldMapping[];
  readonly operations: readonly OperationMapping[];
  readonly ops: ScopeCorrespondenceProposalOps;
  readonly newId: () => string;
}

/**
 * **SS-18.1 — propose a `ScopeCorrespondence` per scoped resource pair of an approved
 * peer-peer mapping.** Driven from the `MappingApproved` artifact-instantiation path,
 * the moment source *and* target resources are both known.
 *
 * It walks the **same** directional resource pairs the instantiation emits `SyncRule`s
 * for ({@link deriveDirectionalResourcePairs}) and, for each, derives a proposal from
 * the two sides' IR + `ResourceBinding`s. A pair that is not scoped yields nothing at
 * all — no correspondence row, and therefore `scope-link` stays unavailable for it
 * (the SS-18 out-of-scope rule; no regression to L1/L2 or non-scoped authoring).
 *
 * **Idempotent (SS-18.6).** The write is `ScopeCorrespondenceRepository.propose`, keyed
 * on the direction-agnostic `resourcePairRef`, so a re-ingested spec, a re-run
 * instantiation, and a second approval all converge on **one** row per pair; a
 * **confirmed** `scopeIdentityKey` is never clobbered, while an unconfirmed candidate is
 * refreshed by the newer derivation. It writes no `scopePathBindings` at all, so a
 * confirmed `scope-link` binding is untouchable from here by construction.
 *
 * A **consumer-provider** mapping proposes nothing: `ScopeCorrespondence` correlates a
 * *sync* resource pair, and the Adapter Engine's `ParameterMapping` path is Phase 5.
 *
 * Returns both halves of the outcome — the stored correspondences (proposed or
 * pre-existing) **and** the pairs that yielded nothing, each with its typed
 * {@link ScopeProposalSkipReason}. The skips matter operationally: `not-scoped` is the
 * expected, uninteresting case, but `target-container-unresolved` /
 * `no-source-scope-capture` / `no-value-preserving-pairing` mean "this pair looks scoped
 * but could not be derived", which is precisely the state an operator would want to see
 * (and which SS-16's lifecycle pass should surface). Nothing consumes them yet — this
 * module has no log sink of its own and adding one is out of SS-18's scope — but they are
 * returned rather than discarded so a caller can.
 */
export async function proposeScopeCorrespondences(
  input: ProposeScopeCorrespondencesInput,
): Promise<ScopeProposalOutcome> {
  const { mapping, fields, operations, ops, newId } = input;
  if (mapping.variant !== "peer-peer") {
    return { proposed: [], skipped: [] };
  }

  const [sourceSpec, targetSpec] = await Promise.all([
    ops.specs.getById(mapping.sourceSpecId),
    ops.specs.getById(mapping.targetSpecId),
  ]);
  if (sourceSpec === undefined || targetSpec === undefined) {
    // A mapping whose spec is gone cannot be derived from; the instantiation itself is
    // unaffected, so this is a no-op rather than a failure of the whole reaction.
    return { proposed: [], skipped: [] };
  }
  const [sourceBindings, targetBindings] = await Promise.all([
    ops.bindings.listByApiSpecId(sourceSpec.id),
    ops.bindings.listByApiSpecId(targetSpec.id),
  ]);

  const proposed: ScopeCorrespondence[] = [];
  const skipped: SkippedScopePair[] = [];
  for (const pair of deriveDirectionalResourcePairs(fields, operations)) {
    const resourcePairRef = canonicalResourcePairRef(
      { appId: mapping.sourceAppId, resourceRef: pair.sourceResourceRef },
      { appId: mapping.targetAppId, resourceRef: pair.targetResourceRef },
    );
    const proposal = deriveScopeCorrespondenceProposal({
      resourcePairRef,
      source: {
        appId: mapping.sourceAppId,
        ir: sourceSpec.parsedIR,
        resourceRef: pair.sourceResourceRef,
        bindings: sourceBindings,
      },
      target: {
        appId: mapping.targetAppId,
        ir: targetSpec.parsedIR,
        resourceRef: pair.targetResourceRef,
        bindings: targetBindings,
      },
      operationMappings: operationsForPair(
        operations,
        pair.sourceResourceRef,
        pair.targetResourceRef,
      ),
      newId,
    });
    if (proposal.kind === "proposed") {
      proposed.push(await ops.correspondences.propose(proposal.correspondence));
    } else {
      skipped.push({ resourcePairRef, reason: proposal.reason });
    }
  }
  return { proposed, skipped };
}

// ── SS-16 — consuming the typed skip reasons (surface "scoped but underivable") ────

/**
 * SS-16 — whether a {@link ScopeProposalSkipReason} means "this pair **looks scoped** but
 * the mediator could not derive its `ScopeCorrespondence`", as opposed to the expected,
 * uninteresting "not scoped". The three underivable reasons —
 * `target-container-unresolved`, `no-source-scope-capture`, `no-value-preserving-pairing`
 * — are precisely the state an operator would want to see (a container write op carries a
 * scope parameter, yet no correspondence could be proposed, so `scope-link` stays
 * unavailable and the pair silently cannot sync scoped). `not-scoped` is not that: it is
 * the SS-18 out-of-scope rule firing correctly.
 *
 * This function is the consumer SS-18 left the reasons for: before it, the typed reasons
 * were **returned but read by nothing** (see `proposeScopeCorrespondences`' doc). Pure, so
 * it is unit-testable and reused wherever the skips are surfaced.
 */
export function isUnderivableScopeSkip(reason: ScopeProposalSkipReason): boolean {
  return reason !== "not-scoped";
}

/**
 * SS-16 — the underivable pairs of a proposal outcome (SS-18), i.e. `outcome.skipped`
 * filtered to {@link isUnderivableScopeSkip}. The operator-facing half of a proposal run:
 * an **empty** result is the healthy case (every pair either proposed a correspondence or
 * was correctly not scoped); a non-empty one lists the pairs that look scoped but could
 * not be derived, each with its typed reason, so a lifecycle pass / observability sink can
 * surface them by `resourcePairRef` without re-deriving anything.
 */
export function underivableScopePairs(outcome: ScopeProposalOutcome): SkippedScopePair[] {
  return outcome.skipped.filter((pair) => isUnderivableScopeSkip(pair.reason));
}

/** A one-line operator-readable explanation of why a scoped-looking pair could not derive. */
export function describeUnderivableScopeSkip(reason: ScopeProposalSkipReason): string {
  switch (reason) {
    case "not-scoped":
      // Not underivable — included for totality; callers gate on `isUnderivableScopeSkip`.
      return "the pair is not container-scoped";
    case "target-container-unresolved":
      return "the target container path parameter resolves to no IR resource with a native id";
    case "no-source-scope-capture":
      return "the source resource captures no container identity (no confirmed sourceScopeRef components)";
    case "no-value-preserving-pairing":
      return "no source scope component pairs value-preservingly to any target container field";
  }
}

/** The `OperationMapping`s whose two sides are exactly this directional resource pair. */
function operationsForPair(
  operations: readonly OperationMapping[],
  sourceResourceRef: string,
  targetResourceRef: string,
): readonly OperationMapping[] {
  return operations.filter(
    (operation) =>
      resourceRefOf(operation.sourceOperationRef) === sourceResourceRef &&
      resourceRefOf(operation.targetOperationRef) === targetResourceRef,
  );
}

// ── The SS-18.4 kind-selector context (read side) ─────────────────────────────

/** Reads the correspondences a resource participates in — `ScopeCorrespondenceRepository` satisfies it. */
export interface ScopeCorrespondenceSideReader {
  listByResourceSide(appId: string, resourceRef: string): Promise<ScopeCorrespondence[]>;
}

export interface ScopeLinkAuthoringDeps {
  readonly correspondences: ScopeCorrespondenceSideReader;
  readonly repos: ContainerBindingRepos;
}

/**
 * The SS-18.4 selector context for one `ResourceBinding`, as the bindings DTO carries it.
 */
export interface ScopeLinkAuthoringContext {
  /** Whether this resource's pair has a proposed `ScopeCorrespondence` (SS-18.1). */
  readonly scopeLinkAvailable: boolean;
  /**
   * The derived `scopeKeyRef` an operator selecting `scope-link` gets pre-filled, **per
   * scope path parameter**. A parameter with no confident derivation is absent from the
   * map rather than defaulted — a wrong container key can address a real-but-wrong
   * container silently.
   */
  readonly scopeKeyRefCandidates: Readonly<Record<string, string>>;
}

/**
 * **SS-18.4 — resolve whether `scope-link` is a selectable kind for a resource, and what
 * `scopeKeyRef` it would be written with.** The read-side counterpart of
 * {@link proposeScopeCorrespondences}: the proposal is what makes `scope-link` available,
 * and this is how the operator UI learns it.
 *
 * `scopeLinkAvailable` is true exactly when the resource participates in a pair that has a
 * proposed `ScopeCorrespondence` — so a **non-scoped** pair (for which the proposal created
 * nothing) keeps `scope-link` unavailable, and L1 `constant` / L2 `record-derived`
 * authoring is entirely unaffected. Confirmation of the correspondence is deliberately
 * *not* required: SS-18.4 makes the kind selectable off a **proposed** correspondence, and
 * the SS-15 gate — not the selector — is what refuses to enable a rule whose scope identity
 * key is still unconfirmed.
 *
 * `scopeKeyRefCandidates` is {@link deriveScopeKeyRefCandidates} over the first matching
 * correspondence. When a resource sits in several scoped pairs the candidates are
 * ambiguous, so none are offered and the operator supplies them — a wrong container key
 * would route writes to the wrong container, which is precisely what L3 exists to prevent.
 */
export class ScopeLinkAuthoringResolver {
  readonly #correspondences: ScopeCorrespondenceSideReader;
  readonly #repos: ContainerBindingRepos;

  public constructor(deps: ScopeLinkAuthoringDeps) {
    this.#correspondences = deps.correspondences;
    this.#repos = deps.repos;
  }

  public async resolve(
    binding: ResourceBinding,
    appId: string,
  ): Promise<ScopeLinkAuthoringContext> {
    // A resource with no scope path parameter can never carry a `scope-link` binding, so
    // skip the lookup entirely (the overwhelmingly common case on a bindings GET).
    if ((binding.scopePathBindings ?? []).length === 0) {
      return { scopeLinkAvailable: false, scopeKeyRefCandidates: {} };
    }
    const correspondences = await this.#correspondences.listByResourceSide(
      appId,
      binding.resourceRef,
    );
    const correspondence = correspondences[0];
    if (correspondence === undefined) {
      return { scopeLinkAvailable: false, scopeKeyRefCandidates: {} };
    }
    if (correspondences.length > 1) {
      // Ambiguous: several scoped pairs claim this resource, so no single container key
      // addresses its parameters. Offer the kind, withhold the guess.
      return { scopeLinkAvailable: true, scopeKeyRefCandidates: {} };
    }
    const targetContainerBinding = await loadContainerBinding(
      this.#repos,
      correspondence.targetContainerRef,
    );
    return {
      scopeLinkAvailable: true,
      scopeKeyRefCandidates: deriveScopeKeyRefCandidates({
        correspondence,
        appId,
        binding,
        targetContainerBinding,
      }),
    };
  }
}
