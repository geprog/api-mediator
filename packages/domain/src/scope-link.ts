import { z } from "zod";

import { scopeLinkEstablishedBySchema, scopeLinkStatusSchema } from "./sync-enums.js";

/**
 * `ScopeLink` — the persisted correspondence between a **container** (scope) in app A
 * and the same logical container in app B (a Gitea repo `alice/phoenix` ↔ a Vikunja
 * project id `42`), the one-level-up analog of `RecordLink`
 * (`docs/architecture/data-model.md` `ScopeLink`; `docs/glossary.md` `ScopeLink`;
 * requirement SS-10). Two independently-owned apps assign their own container ids, so
 * a scoped `SyncRule` resolves each record's target scope through this explicit,
 * persisted pairing rather than assuming shared ids. Deliberately **not** an
 * `ApprovedMapping` — a container correspondence is identity state, so it lives here
 * alongside `RecordLink`.
 *
 * Types only, no behavior: establishing / discovering / archiving is SS-11 / SS-12 /
 * Phase 6. References its two apps **by id only** — carries no credential material.
 */

/**
 * One side's **scope key**: that app's own container identifier, captured as the
 * value of that side's **scope identity key** (`docs/architecture/data-model.md`
 * `ScopeLink.appAScopeKey`/`appBScopeKey`). Modeled as a `{ component → value }`
 * **map** rather than a bare string because a container may have several scope
 * identity-key components (Gitea `{ owner, name }`) while another has one
 * (Vikunja `{ id }`), and a `kind: scope-link` scope binding's `scopeKeyRef` selects
 * **which** component fills a given target scope parameter (SS-12). Keyed by the
 * scope identity-key component name for that side; at least one entry (a container
 * always has an identity). Mirrors the captured-scope `{ key → value }` map.
 */
export const scopeKeySchema = z.record(z.string(), z.string());
export type ScopeKey = z.infer<typeof scopeKeySchema>;

/**
 * Field notes:
 *
 * - `scopeCorrespondenceId` — the parent `ScopeCorrespondence` (config) this instance
 *   was established under.
 * - `appAId`/`appAScopeKey`, `appBId`/`appBScopeKey` — the two apps' own container
 *   ids and their captured scope-key maps; a `kind: scope-link` binding filling a
 *   *target*-side scope parameter reads the target app's `appXScopeKey`.
 * - `resourcePairRef` — the scoped resource pair this container correspondence serves,
 *   in the same **canonical direction-agnostic form** as `RecordLink.resourcePairRef`
 *   (a plain opaque string), so **both directions** of a bidirectional pair resolve
 *   the same link (SS-10 criterion 3).
 * - `establishedBy` — `constant` | `identity-match` | `manual` (mirrors
 *   `RecordLink.establishedBy` minus `create-propagation`).
 * - `status` — `active` | `archived`; `archived` (never deleted) when a container/app
 *   leaves the landscape, so a `RecordLink.scopeRef` pointing at it still resolves
 *   (SS-10 criterion 5).
 */
export const scopeLinkSchema = z
  .object({
    id: z.string(),
    scopeCorrespondenceId: z.string(),
    appAId: z.string(),
    appAScopeKey: scopeKeySchema,
    appBId: z.string(),
    appBScopeKey: scopeKeySchema,
    resourcePairRef: z.string(),
    establishedBy: scopeLinkEstablishedBySchema,
    status: scopeLinkStatusSchema,
    createdAt: z.date(),
  })
  .superRefine((link, ctx) => {
    // Each side's scope key is the value of a scope identity key with at least one
    // pairing, so an empty map is an unrepresentable container (no identity).
    if (Object.keys(link.appAScopeKey).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "appAScopeKey must carry at least one scope-key component",
        path: ["appAScopeKey"],
      });
    }
    if (Object.keys(link.appBScopeKey).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "appBScopeKey must carry at least one scope-key component",
        path: ["appBScopeKey"],
      });
    }
  });
export type ScopeLink = z.infer<typeof scopeLinkSchema>;
