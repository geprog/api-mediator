import type {
  AuditLogEntry,
  FieldMapping,
  RecordLink,
  RecordLinkScopeRef,
  TombstoneReason,
} from "@mediator/domain";
import type { CapturedScope, JsonRecord, JsonValue } from "@mediator/transform";

/**
 * Types for the **Identity Resolution** stage — the sync pipeline's first stage
 * (`docs/architecture/sync-engine.md` *Identity correlation*, *Change types*;
 * `docs/requirements/phase-4-identity-record-link.md` RL-1..RL-5). It resolves (or
 * establishes) the `RecordLink` every downstream stage is keyed by, and owns the
 * **ambiguous-match → manual-only** guard (RL-4), the create-propagation link write
 * (RL-2), the identity-match + seed (RL-3), and the manual-link / tombstone
 * lifecycle (RL-5).
 *
 * The ports here are defined by the *consumer* (this stage), inverting the
 * dependency so `@mediator/sync-engine` never imports `@mediator/outbound` (which
 * already depends on `@mediator/sync-engine` for the ordering-queue
 * `FailureDisposition`). The real `SyncEventStore`/`OutboundCallExecutor` structurally
 * satisfy these ports and are wired at the composition root.
 */

/** The action a detected change carries (`docs/architecture/sync-engine.md` *Change types*). */
export type ChangeKind = "create" | "update" | "delete";

/**
 * SP-3's per-record **detected-change descriptor** — the stage's primary input (the
 * shape SP's classification produces; SP wires it later). Everything the stage needs
 * that is *not* per-record (the confirmed identity key, the lookup path, the create
 * operation, the field pairings) arrives in the {@link ResolutionContext}.
 */
export interface DetectedChange {
  readonly ruleId: string;
  readonly mappingId: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
  /** The mapped resource pair in canonical direction-agnostic form (keys links/state). */
  readonly resourcePairRef: string;
  readonly sourceNativeId: string;
  readonly changeKind: ChangeKind;
  /** The source record as observed this poll. Absent/undefined on a delete (the record is gone). */
  readonly observedRecord?: JsonRecord | undefined;
  /**
   * The record's **captured scope** (`docs/glossary.md` *captured scope*; SS-8
   * criterion 5) — the `{ component-key → value }` map the Poller extracted from the
   * observed record via the **source** resource's confirmed `sourceScopeRef` (SS-7),
   * riding **with** this detected change as an in-flight attribute (NOT persisted sync
   * state, so the Poller's single per-rule `cursor`/snapshot is unchanged — SS-8.2). A
   * `record-derived` **target** scope binding (SS-8.3) fills its scope path parameter
   * from this by the binding's `sourceScopeKey`, and — under multi-scope — scoped
   * identity (SS-14) consumes it. **Absent** for a non-scoped / constant-only rule (the
   * source resource has no confirmed `sourceScopeRef`) and on a delete (the source
   * record is gone, so nothing was captured) — backward-compatible.
   */
  readonly capturedScope?: CapturedScope | undefined;
}

/**
 * The resolved binding the identity lookup needs — the target's collection read +
 * native-id field. A minimal, transport-agnostic descriptor (the real
 * ProtocolClient-backed lookup client resolves it to HTTP; SP/BE own that wiring):
 * kept decoupled from `@mediator/outbound`'s `RestOperationBinding` to avoid the
 * dependency cycle.
 */
export interface TargetReadBinding {
  /** IR operation id of the target's confirmed collection read (`ResourceBinding.collectionReadRef`). */
  readonly collectionReadOperationId: string;
  /** The target's native-id field path (`ResourceBinding.nativeIdRef`) — a match's native id. */
  readonly nativeIdPath: string;
}

/**
 * How the target can be looked up by the identity value (RL-3.1/3.2/3.5):
 *  - `filtered-read` — the target's collection read exposes the confirmed filter
 *    parameter (`FieldMapping.targetLookupParamRef`); **preferred**.
 *  - `fetch-and-match` — no filter, but the target is enumerable (a confirmed
 *    `ResourceBinding.collectionReadRef`); complete fetch + in-memory compare.
 *  - `none` — **neither** path: match-first is unavailable, links form only via
 *    create-propagation or manual, creates go straight to create (duplicate risk).
 */
export type TargetLookupCapability =
  | {
      readonly kind: "filtered-read";
      readonly binding: TargetReadBinding;
      readonly lookupParamRef: string;
    }
  | { readonly kind: "fetch-and-match"; readonly binding: TargetReadBinding }
  | { readonly kind: "none" };

/**
 * The per-rule resolved artifacts SP assembles for the stage (from the
 * `ApprovedMapping`, `ResourceBinding`s, and `SyncRule`). Direction-scoped: the
 * `identitySourcePath`/`fieldMappings` are *this* rule's source→target direction.
 */
export interface ResolutionContext {
  /** Canonical A/B app assignment for `resourcePairRef` (ordered by a stable key, not by direction). */
  readonly appAId: string;
  readonly appBId: string;
  /** The confirmed identity `FieldMapping`'s source & target IR paths. The value is used **AS-IS** (RL-3.3). */
  readonly identitySourcePath: string;
  readonly identityTargetPath: string;
  /** The target lookup path (prefer filtered read, fall back to fetch-and-match, else none). */
  readonly targetLookup: TargetLookupCapability;
  /** Whether the mapping has an approved `action = create` `OperationMapping` (RL-2.2 policy). */
  readonly hasApprovedCreateOperation: boolean;
  /** This direction's `FieldMapping`s — the identity-match seed's pairings (RL-3.4 / BE-4). */
  readonly fieldMappings: readonly FieldMapping[];
  /**
   * SS-12.2/12.7 — the record's **container**, resolved by the composition for a **scoped**
   * rule from this change's captured scope (L3: the matched active `ScopeLink`'s id, as
   * `{ kind: "scope-link", scopeLinkId }`; L2 `record-derived`: the frozen resolved fill,
   * as `{ kind: "resolved", values }`), to be **frozen onto the new `RecordLink.scopeRef`**
   * at establishment (create-propagation / identity-match). Absent on a non-scoped rule and
   * whenever the container did not resolve — the link is then established with no `scopeRef`
   * (a later delete/no-capture read parks for manual container linking, never mis-writes).
   */
  readonly scopeRefForNewLink?: RecordLinkScopeRef;
  /**
   * SS-14.1 — the **target-side** container scope path-param fill (`{ parameterName → value }`)
   * a **scoped** identity lookup fills its collection read with, so a filtered read / a
   * fetch-and-match searches **only within** the record's resolved target container (project
   * `42`, `alice/phoenix`), never globally. Resolved by the composition from the change's
   * captured scope (L3: the matched active `ScopeLink`'s target-side key; L2 `record-derived`:
   * the resolved fill). **Absent** on a non-scoped rule and whenever the container did not
   * resolve — the lookup then fails closed (a still-templated container `{…}` refuses the
   * read) rather than enumerating globally and fabricating a wrong match.
   */
  readonly targetContainerScope?: ReadonlyMap<string, string>;
}

/** A target record a lookup matched: its native id + the record body (for the seed). */
export interface MatchedTargetRecord {
  readonly nativeId: string;
  readonly record: JsonRecord;
}

/**
 * Result of a complete target fetch (fetch-and-match). Abort-on-partial is
 * **explicit**: a failed page yields `complete: false`, and the stage must NOT infer
 * a match or a no-match from a truncated fetch — it aborts (the change retries), so
 * no link/create/write side effect happens on a partial read.
 */
export type TargetFetchResult =
  | { readonly complete: true; readonly records: readonly MatchedTargetRecord[] }
  | { readonly complete: false };

/** A filtered-read lookup: the target's collection read filtered by `lookupParamRef = value`. */
export interface FilteredReadRequest {
  readonly targetAppId: string;
  readonly binding: TargetReadBinding;
  readonly lookupParamRef: string;
  /** The identity value, used **AS-IS** — no transform is ever applied to it (RL-3.3). */
  readonly value: JsonValue;
  /**
   * SS-14.1 — the resolved target **container** scope path-param fill. When present the
   * filtered read fills its collection read's container `{…}` from it, so it searches **only
   * within** that container. Absent on a non-scoped rule (a global-within-the-app read).
   */
  readonly containerScope?: ReadonlyMap<string, string>;
}

/** A complete paged fetch of the target resource, for in-memory matching. */
export interface FetchAllRequest {
  readonly targetAppId: string;
  readonly binding: TargetReadBinding;
  /**
   * SS-14.1 — the resolved target **container** scope path-param fill. When present the
   * fetch enumerates **only** that container (its scoped collection read), never globally.
   * Absent on a non-scoped rule.
   */
  readonly containerScope?: ReadonlyMap<string, string>;
}

/**
 * The target-lookup port (RL-3). The stage chooses *which* method per
 * {@link TargetLookupCapability} and owns the match count + the ambiguous guard; the
 * port owns the transport (paging to exhaustion, abort-on-partial). Faked in unit
 * tests; the real ProtocolClient-backed implementation is SP/BE's wiring seam.
 */
export interface TargetIdentityLookup {
  /**
   * Filtered read — the target does the filtering; the stage counts the returned
   * records and applies the ambiguous guard (a filter that returns >1 is ambiguous).
   */
  filteredRead(request: FilteredReadRequest): Promise<readonly MatchedTargetRecord[]>;
  /**
   * Complete paged fetch of the target resource for in-memory matching. **Abort-on-
   * partial**: a failed page returns `{ complete: false }` (never a fabricated match).
   */
  fetchAll(request: FetchAllRequest): Promise<TargetFetchResult>;
}

/**
 * The narrow `SyncEvent`/`AuditLog` append port the stage needs for its own
 * resolution events (RL-4 ambiguous failure, RL-5 skipped-policy) — the same shape
 * `@mediator/outbound`'s `SyncEventStore` exposes, so its `DbSyncEventStore` /
 * `FakeSyncEventStore` satisfy it structurally (no import, no cycle).
 */
export interface SyncEventRecorder {
  record(entry: AuditLogEntry): Promise<void>;
}

/**
 * Identity-resolution metrics (RL-1.5 / RL-4.3). `no-match` and `ambiguous-match`
 * are **distinct** rates — a wrong identity key shows up as ambiguity, never as a
 * benign no-match. Default no-op; SP/telemetry wires OTel counters.
 */
export interface IdentityResolutionMetrics {
  /** A lookup found no target match — a genuine create (RL-1.5). */
  recordNoMatch(ruleId: string): void;
  /** A lookup matched more than one target — the ambiguous-match rate, DISTINCT from no-match (RL-4.3). */
  recordAmbiguousMatch(ruleId: string): void;
}

/** The minimal active-trace context the stage stamps onto its `SyncEvent`s (optional). */
export interface StageTraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

/** Why a change was recorded `skipped-policy` by the stage. */
export type SkippedPolicyReason = "no-create-op" | "counterpart-deleted";

/**
 * The stage's resolution outcome for one detected change. A discriminated union —
 * every terminal disposition (ambiguous failure, skipped-policy, severed tombstone,
 * straight create) is modeled explicitly rather than as optional-field soup, so the
 * caller (SP) can never mistake, say, a straight create for a resolved link.
 */
export type ResolutionOutcome =
  | ResolvedOutcome
  | StraightCreateOutcome
  | AmbiguousFailureOutcome
  | SkippedPolicyOutcome
  | SeveredTombstoneOutcome
  | NoLinkDeleteOutcome;

/** RL-1.2 (existing active link) / RL-3.4 (identity match established one). */
export interface ResolvedOutcome {
  readonly kind: "resolved";
  readonly link: RecordLink;
  /**
   * The change to run downstream. A create/update that resolves to a link routes as
   * an **update** (a matched create is *downgraded* — RL-3.4); a delete stays a
   * delete (handled downstream, then tombstoned via {@link processDeletion}).
   */
  readonly effectiveChangeKind: ChangeKind;
  /** True when this resolution just established the link via identity match (and seeded field state). */
  readonly establishedByIdentityMatch: boolean;
}

/**
 * RL-2 / RL-3.5: no identity match → proceed to create. The link is written later by
 * {@link IdentityResolutionStage.recordCreatePropagation} from the create response's
 * native id. `matchFirstAvailable = false` is the degraded neither-lookup-path case
 * (documented duplicate risk).
 */
export interface StraightCreateOutcome {
  readonly kind: "straight-create";
  readonly matchFirstAvailable: boolean;
}

/**
 * RL-4 — the ambiguous-match guard fired: **no** link, **no** create, **no** write.
 * A `failure` `SyncEvent` carrying the candidate ids was recorded ({@link syncEventId}).
 */
export interface AmbiguousFailureOutcome {
  readonly kind: "ambiguous-failure";
  readonly candidateNativeIds: readonly string[];
  readonly syncEventId: string;
}

/** RL-2.2 (no create op) / RL-5.4 (counterpart deleted): recorded `skipped-policy`, visible, no write. */
export interface SkippedPolicyOutcome {
  readonly kind: "skipped-policy";
  readonly reason: SkippedPolicyReason;
  readonly syncEventId: string;
  /** The tombstoned link, when the skip is because the counterpart was deleted (RL-5.4). */
  readonly recordLink?: RecordLink;
}

/**
 * RL-5.5 — the record's link is tombstoned, so resurrection is prevented: **no**
 * create, **no** write. For a `propagated-delete` tombstone the precise echo status
 * (`skipped-loop`) is the deferred EP delete-echo seam; the stage's guarantee here is
 * only that it does not re-create what was just deleted.
 */
export interface SeveredTombstoneOutcome {
  readonly kind: "severed-tombstone";
  readonly tombstoneReason: TombstoneReason;
  readonly link: RecordLink;
}

/** A delete for a record with no link (nothing to route/tombstone) — SP records it, no side effect. */
export interface NoLinkDeleteOutcome {
  readonly kind: "no-link-delete";
}
