import type {
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
} from "@mediator/db";
import type { Ir, ResourceBinding, ScopeCorrespondence } from "@mediator/domain";
import {
  revalidateResourceBinding,
  revalidateScopeCorrespondence,
  type ScopeCorrespondenceSide,
  type ScopeRevalidationFinding,
} from "@mediator/ir";

/**
 * **SS-16 — the scope-artifact re-validation application service.** The seam between the
 * Phase-6 spec-update lifecycle and the pure re-validation **policy** (`@mediator/ir`
 * `revalidateResourceBinding` / `revalidateScopeCorrespondence`): the policy decides *what*
 * a re-ingested spec invalidates, this **persists** the consequence and returns the typed
 * findings.
 *
 * ## Why this is a capability, not a wired trigger
 *
 * SS-16 criterion 6 scopes this story to "only the `scopePathBindings` /
 * `ScopeCorrespondence` / `ScopeLink` behavior within that lifecycle" — the
 * `SpecDiff` / re-pin / successor-adoption machinery that *fires* re-validation is
 * Phase-6-owned (`docs/architecture/extensibility.md`). So, exactly as
 * `ScopeLinkRepository.archiveByCorrespondence` shipped the SS-10.5 archive *capability*
 * ahead of its Phase-6 trigger, this service ships the re-validation capability ahead of
 * the diff that will call it. It is deliberately **not** invoked from ingestion yet:
 * `SpecRegistry` still only ingests v1.
 *
 * ## How a rule "pauses"
 *
 * Nothing here writes a rule status. A `SyncRule` **pauses** the moment a required scope
 * artifact goes unconfirmed, because the runtime already refuses to use an unconfirmed
 * artifact: `poll-plan-resolver` returns `pollable: false` for an unconfirmed
 * poll/collection ref, `binding-resolvers` never fabricate a convention from an unconfirmed
 * ref, and `resolveRecordAddressing` yields `unconfirmed-address-ref` (park) for a
 * container-scoped resource. So persisting the policy's unconfirmed artifacts **is** the
 * pause — derived at execution time, exactly like an app-disable condition and exactly as
 * `pollOperationRef` re-validation pauses a rule (`docs/architecture/extensibility.md`).
 * This is fail-loud: a stale scope artifact blocks, it is never used as-is, and only a
 * human (the SS-6/SS-9/SS-15 confirm panels) clears it — nothing here auto-confirms.
 */
export interface ScopeLifecycleDeps {
  readonly resourceBindings: ResourceBindingRepository;
  readonly scopeCorrespondences: ScopeCorrespondenceRepository;
  readonly scopeLinks: ScopeLinkRepository;
}

/** SS-16.1/16.2/16.3 — the result of re-validating one spec's `ResourceBinding`s. */
export interface SpecScopeRevalidationResult {
  /** Every finding across the spec's bindings, in binding order (empty = a clean additive re-pin). */
  readonly findings: readonly ScopeRevalidationFinding[];
  /** The re-validated bindings as they were persisted (in-place, same ids). */
  readonly bindings: readonly ResourceBinding[];
}

/** SS-16.4/16.5 — the result of re-validating one pair's `ScopeCorrespondence`. */
export interface CorrespondenceRevalidationResult {
  readonly findings: readonly ScopeRevalidationFinding[];
  /** The re-validated correspondence as persisted (returned to unconfirmed when any finding fired). */
  readonly correspondence: ScopeCorrespondence;
  /** How many `ScopeLink`s were archived (never deleted) as a consequence (SS-16.5). */
  readonly archivedScopeLinks: number;
}

export class ScopeLifecycleService {
  readonly #resourceBindings: ResourceBindingRepository;
  readonly #scopeCorrespondences: ScopeCorrespondenceRepository;
  readonly #scopeLinks: ScopeLinkRepository;

  public constructor(deps: ScopeLifecycleDeps) {
    this.#resourceBindings = deps.resourceBindings;
    this.#scopeCorrespondences = deps.scopeCorrespondences;
    this.#scopeLinks = deps.scopeLinks;
  }

  /**
   * **SS-16.1/16.2/16.3 (+ SS-19 `recordAddressRef`) — re-validate every `ResourceBinding`
   * of a spec against its re-ingested IR, and persist the result in place.**
   *
   * Each binding is re-validated by {@link revalidateResourceBinding} (the pure policy) and
   * written back with {@link ResourceBindingRepository.replaceRevalidated}. A binding with
   * **no** findings is re-validated to a byte-identical value (the additive-re-pin case,
   * SS-16.1) and still written — harmlessly idempotent — so the caller need not special-case
   * it. A binding **with** findings has its invalidated refs / scope path bindings /
   * `sourceScopeRef` returned to unconfirmed, which pauses every rule that depends on them.
   *
   * `newIr` is passed explicitly rather than read from a spec row: the Phase-6 diff already
   * holds the newly-parsed IR, and taking it as a parameter keeps this method usable before
   * the (Phase-6) re-pin has swapped a spec's stored `parsedIR`. The bindings themselves are
   * the carried-forward, operator-confirmed bindings the caller already attached to `specId`.
   */
  public async revalidateSpecBindings(
    specId: string,
    newIr: Ir,
  ): Promise<SpecScopeRevalidationResult> {
    const stored = await this.#resourceBindings.listByApiSpecId(specId);
    const findings: ScopeRevalidationFinding[] = [];
    const persisted: ResourceBinding[] = [];
    for (const binding of stored) {
      const revalidation = revalidateResourceBinding(binding, newIr);
      findings.push(...revalidation.findings);
      const written = await this.#resourceBindings.replaceRevalidated(revalidation.binding);
      // `replaceRevalidated` returns undefined only if the row vanished mid-pass (it did
      // not — we just listed it); fall back to the policy output so the result is total.
      persisted.push(written ?? revalidation.binding);
    }
    return { findings, bindings: persisted };
  }

  /**
   * **SS-16.4/16.5 — re-validate one pair's `ScopeCorrespondence` against both sides'
   * re-ingested IR + bindings, persist the result, and archive the `ScopeLink`s the change
   * invalidated.**
   *
   * The two `ScopeCorrespondenceSide`s are supplied by the caller (Phase 6 assembles them
   * from the diff's new IR for the changed side and persisted state for the counterpart) —
   * the same shape SS-18's `deriveScopeCorrespondenceProposal` takes, so derivation and
   * re-validation read the world identically.
   *
   * On any finding the correspondence is written back **unconfirmed** (via
   * {@link ScopeCorrespondenceRepository.confirmOrUpdate}, which also clears a now-invalid
   * `sourceContainerRef` — flipping the derived poll-scope mode to the fail-safe
   * `per-scope-pinned`), and its `ScopeLink`s are **archived, never deleted** (SS-16.5), so a
   * `RecordLink.scopeRef` pointing at one still resolves its frozen key for a final
   * delete/audit. A container-gone break archives **all** links; a scope-identity-key break
   * archives only `identity-match` links (a `constant`/`manual` link is operator-pinned and
   * independent of the key). With no finding the correspondence carries forward untouched
   * (SS-16.1) and no link is archived.
   */
  public async revalidateCorrespondence(
    correspondence: ScopeCorrespondence,
    source: ScopeCorrespondenceSide,
    target: ScopeCorrespondenceSide,
  ): Promise<CorrespondenceRevalidationResult> {
    const revalidation = revalidateScopeCorrespondence({ correspondence, source, target });
    if (revalidation.findings.length === 0) {
      return {
        findings: revalidation.findings,
        correspondence: revalidation.correspondence,
        archivedScopeLinks: 0,
      };
    }

    const persisted = await this.#scopeCorrespondences.confirmOrUpdate(revalidation.correspondence);
    let archivedScopeLinks = 0;
    if (revalidation.archiveScopeLinks === "all") {
      archivedScopeLinks = await this.#scopeLinks.archiveByCorrespondence(correspondence.id);
    } else if (revalidation.archiveScopeLinks === "identity-match") {
      archivedScopeLinks = await this.#scopeLinks.archiveByCorrespondence(correspondence.id, {
        establishedBy: "identity-match",
      });
    }
    return { findings: revalidation.findings, correspondence: persisted, archivedScopeLinks };
  }
}
