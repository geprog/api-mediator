import { z } from "zod";

/**
 * Canonical domain enumerations for the Phase 4 sync-execution slice
 * (`SyncRule` execution fields, `RecordLink`, `SyncFieldState`).
 *
 * Same triple-derivation pattern as `enums.ts` / `mapping-enums.ts` /
 * `approved-mapping-enums.ts` (a single tuple of literals yields the Zod
 * validator, the string-union type, and the `as const`-style value object):
 *
 * ```ts
 * export const fooSchema = z.enum(["a", "b"]);   // runtime validator
 * export type Foo = z.infer<typeof fooSchema>;   // "a" | "b"
 * export const Foo = fooSchema.enum;             // { a: "a"; b: "b" }
 * ```
 *
 * Literal spellings are taken **verbatim** from `docs/architecture/data-model.md`
 * and `docs/glossary.md` and must not be renamed. This is the single naming
 * authority, so each enum lists **every** value its column can hold — including
 * values only a later execution slice ever writes.
 */

// ── SyncRule.deletePropagation (SD-1) ────────────────────────────────────────

/**
 * Whether a detected source-side deletion is propagated to the target
 * (`docs/architecture/data-model.md` `SyncRule.deletePropagation`;
 * `docs/glossary.md` `deletePropagation`). Default `ignore` — deletion is the one
 * destructive operation the mediator can perform, so it is opt-in per rule; the
 * default itself is applied by the persistence/instantiation layer, not this
 * type. An ignored deletion is still recorded (`SyncEvent.status = skipped-policy`),
 * never silently dropped.
 */
export const deletePropagationSchema = z.enum(["ignore", "propagate"]);
export type DeletePropagation = z.infer<typeof deletePropagationSchema>;
export const DeletePropagation = deletePropagationSchema.enum;

// ── SyncRule.targetDriftCheck (SD-1) ─────────────────────────────────────────

/**
 * Opt-in target-drift protection (`docs/architecture/data-model.md`
 * `SyncRule.targetDriftCheck`). Default `none`; `read-before-write` reads the
 * target record immediately before writing and treats a mapped-field divergence
 * from its `lastSyncedHash` as a conflict instead of silently overwriting it.
 */
export const targetDriftCheckSchema = z.enum(["none", "read-before-write"]);
export type TargetDriftCheck = z.infer<typeof targetDriftCheckSchema>;
export const TargetDriftCheck = targetDriftCheckSchema.enum;

// ── SyncRule.backfillMode (SD-1) ─────────────────────────────────────────────

/**
 * The one-time initial reconciliation mode (`docs/architecture/data-model.md`
 * `SyncRule.backfillMode`; `docs/glossary.md` `Initial backfill`). `link-only`
 * (default) links matched records and seeds `SyncFieldState` baselines, writing
 * nothing to either app; `push` declares the source the initial source of truth
 * and pushes mapped values to the target.
 */
export const backfillModeSchema = z.enum(["link-only", "push"]);
export type BackfillMode = z.infer<typeof backfillModeSchema>;
export const BackfillMode = backfillModeSchema.enum;

// ── SyncRule.backfillStatus (SD-1) ───────────────────────────────────────────

/**
 * Lifecycle of the rule's one-time backfill (`docs/architecture/data-model.md`
 * `SyncRule.backfillStatus`). A freshly instantiated rule is `pending`; the enable
 * action starts the backfill (`running`) and polling begins only once it is
 * `completed` or explicitly `skipped`.
 */
export const backfillStatusSchema = z.enum(["pending", "running", "completed", "skipped"]);
export type BackfillStatus = z.infer<typeof backfillStatusSchema>;
export const BackfillStatus = backfillStatusSchema.enum;

// ── RecordLink.establishedBy (SD-2) ──────────────────────────────────────────

/**
 * How a `RecordLink` was established (`docs/architecture/data-model.md`
 * `RecordLink.establishedBy`): `create-propagation` (the target's new native id
 * captured from a create response), `identity-match` (matched via the confirmed
 * identity `FieldMapping` during backfill or steady state), or `manual` (linked
 * explicitly in the UI).
 */
export const recordLinkEstablishedBySchema = z.enum([
  "create-propagation",
  "identity-match",
  "manual",
]);
export type RecordLinkEstablishedBy = z.infer<typeof recordLinkEstablishedBySchema>;
export const RecordLinkEstablishedBy = recordLinkEstablishedBySchema.enum;

// ── RecordLink.status (SD-2) ─────────────────────────────────────────────────

/**
 * The `RecordLink` lifecycle status (`docs/architecture/data-model.md`
 * `RecordLink.status`). A link is `tombstoned`, never deleted, whenever either
 * side's record is deleted; `archived` is the distinct app-deregistration outcome
 * (the pair was not severed by a deletion — its app left the landscape).
 */
export const recordLinkStatusSchema = z.enum(["active", "tombstoned", "archived"]);
export type RecordLinkStatus = z.infer<typeof recordLinkStatusSchema>;
export const RecordLinkStatus = recordLinkStatusSchema.enum;

// ── RecordLink.tombstoneReason (SD-2) ────────────────────────────────────────

/**
 * Why a `RecordLink` was tombstoned (`docs/architecture/data-model.md`
 * `RecordLink.tombstoneReason`; `docs/glossary.md` `Tombstone`): `propagated-delete`
 * (the mediator itself propagated the deletion — recognizes the other side's delete
 * echo) or `observed-delete` (a source deletion observed but not propagated under
 * `deletePropagation = ignore`). Present only on a `tombstoned` link.
 */
export const tombstoneReasonSchema = z.enum(["propagated-delete", "observed-delete"]);
export type TombstoneReason = z.infer<typeof tombstoneReasonSchema>;
export const TombstoneReason = tombstoneReasonSchema.enum;

// ── ScopeLink.establishedBy (SS-10) ──────────────────────────────────────────

/**
 * How a `ScopeLink` was established (`docs/architecture/data-model.md`
 * `ScopeLink.establishedBy`; `docs/glossary.md` `ScopeLink`): `constant` (a
 * single-scope operator literal), `identity-match` (a discovered match of the two
 * sides' *scope identity keys*), or `manual` (an explicit UI link). Mirrors
 * `RecordLink.establishedBy` **minus `create-propagation`** — the mediator rarely
 * creates containers, so a container correspondence is never captured from a
 * create response.
 */
export const scopeLinkEstablishedBySchema = z.enum(["constant", "identity-match", "manual"]);
export type ScopeLinkEstablishedBy = z.infer<typeof scopeLinkEstablishedBySchema>;
export const ScopeLinkEstablishedBy = scopeLinkEstablishedBySchema.enum;

// ── ScopeLink.status (SS-10) ─────────────────────────────────────────────────

/**
 * The `ScopeLink` lifecycle status (`docs/architecture/data-model.md`
 * `ScopeLink.status`). `archived` when either side's container or app leaves the
 * landscape (same rationale as `RecordLink`'s `archived`) — set, never deleted, so
 * a `RecordLink.scopeRef` pointing at an archived `ScopeLink` still resolves its
 * frozen container key for a final delete/audit (SS-10 criterion 5). No `tombstoned`
 * value: a container correspondence is not severed by a record deletion.
 */
export const scopeLinkStatusSchema = z.enum(["active", "archived"]);
export type ScopeLinkStatus = z.infer<typeof scopeLinkStatusSchema>;
export const ScopeLinkStatus = scopeLinkStatusSchema.enum;

// ── SyncFieldState.side (SD-3) ───────────────────────────────────────────────

/**
 * Which side of the `RecordLink` a `SyncFieldState` row tracks
 * (`docs/architecture/data-model.md` `SyncFieldState.side`) — `A` or `B`, as the
 * link's `appAId`/`appBId` define them. Deliberately side-and-field keyed, not
 * pairing- or `SyncRule`-keyed, so both directions of a bidirectional pair read
 * and write the same per-side rows.
 */
export const syncFieldStateSideSchema = z.enum(["A", "B"]);
export type SyncFieldStateSide = z.infer<typeof syncFieldStateSideSchema>;
export const SyncFieldStateSide = syncFieldStateSideSchema.enum;

// ── SyncFieldState.status (SD-3) ─────────────────────────────────────────────

/**
 * The `SyncFieldState` status (`docs/architecture/data-model.md`
 * `SyncFieldState.status`). `archived` rows are retained but never read or written
 * again — set when a successor mapping drops the row's field pair, or when either
 * side's app is deregistered (Phase 6).
 */
export const syncFieldStateStatusSchema = z.enum(["active", "archived"]);
export type SyncFieldStateStatus = z.infer<typeof syncFieldStateStatusSchema>;
export const SyncFieldStateStatus = syncFieldStateStatusSchema.enum;
