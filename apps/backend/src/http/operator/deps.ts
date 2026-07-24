import { z } from "zod";

import type { AdapterCompositionService } from "../../modules/adapter-composition/index.js";
import type {
  AdapterRequestHistoryReader,
  AdapterStateReader,
} from "../../modules/adapter-state.js";
import type { ExclusionsReplacer } from "../../modules/analysis-exclusions.js";
import type {
  ApprovalService,
  EscapeHatchService,
  ProposalReadService,
} from "../../modules/approval/index.js";
import type { AdapterTokenService } from "../../modules/adapter-token/index.js";
import type {
  ApprovedMappingReader,
  ApprovedMappingSuspensionMutator,
} from "./approved-mappings.routes.js";
import type { AppLifecycleMutator } from "./apps.routes.js";
import type { AppReader, BindingReader, SpecReader } from "../../modules/persistence.js";
import type { Registrar } from "../../modules/registration.js";
import type { BindingConfirmer } from "../../modules/resource-bindings.js";
import type { ScopeLinkAuthoringResolver } from "../../modules/scope-authoring.js";
import type { SyncOperatorService } from "../../modules/sync/operator.js";

/**
 * Everything the operator `/api` routes depend on, injected by the composition
 * root. Reads go through the pooled reader ports; mutations through the
 * transactional services. Routes hold no persistence of their own, which is what
 * lets the unit tests drive the whole surface with in-memory fakes.
 */
export interface OperatorApiDeps {
  readonly registrar: Registrar;
  readonly appReader: AppReader;
  readonly specReader: SpecReader;
  readonly bindingReader: BindingReader;
  readonly bindingConfirmer: BindingConfirmer;
  /**
   * SS-18.4 — resolves, per `ResourceBinding`, whether `scope-link` is a selectable
   * scope-binding kind (its pair has a proposed `ScopeCorrespondence`) and the derived
   * `scopeKeyRef` a selection would carry. Read-only; it confirms nothing.
   */
  readonly scopeLinkAuthoring: ScopeLinkAuthoringResolver;
  readonly exclusionsReplacer: ExclusionsReplacer;
  // Phase-3 Review & Approval (RA-1..RA-5): the read side, the Approval Service
  // (per-item decisions + identity-key confirmation + approve), and the
  // shortlist-miss escape hatch.
  readonly proposalReadService: ProposalReadService;
  readonly approvalService: ApprovalService;
  readonly escapeHatchService: EscapeHatchService;
  /**
   * Phase-5 Auth Gateway & adapter token (AT-1/AT-4): issue/rotate/cutover a
   * consumer app's inbound adapter token, attributing each action in the audit log.
   * The real composition root always provides it, so the routes are mounted in
   * production; optional only so the pre-Phase-5 in-memory unit harness (no real db)
   * legitimately omits it, exactly like `sync`. The per-request token *validation*
   * the gateway does lives in the Adapter Server Runtime, not here.
   */
  readonly adapterTokens?: AdapterTokenService;
  /**
   * Phase-5 endpoint composition (CO-2): validate + atomically activate a
   * `composition-required` `AdapterEndpoint`. Optional for the same reason as
   * `adapterTokens`/`sync` — the real composition root always provides it (so the route
   * is mounted in production), while the pre-Phase-5 in-memory unit harness, which has no
   * real db/transaction, legitimately omits it and the route is simply not registered.
   */
  readonly adapterComposition?: AdapterCompositionService;
  /**
   * Phase-6 SL-10 — the manual suspend/resume of an `ApprovedMapping`, paired with the
   * reader behind the operator list. Optional for the same reason as `adapterComposition`:
   * the real composition root always provides both (so the routes are mounted in
   * production), while the in-memory unit harness — which has no real db/transaction —
   * legitimately omits them and the routes are simply not registered.
   */
  readonly approvedMappingSuspension?: ApprovedMappingSuspensionMutator;
  readonly approvedMappingReader?: ApprovedMappingReader;
  /**
   * Phase-6 AL-1 — the reversible app disable/enable. Optional for the same reason as
   * `approvedMappingSuspension`: the real composition root always provides it (so the two
   * routes are mounted in production), while the in-memory unit harness — which has no
   * real db/transaction — legitimately omits it and the routes are simply not registered.
   */
  readonly appLifecycle?: AppLifecycleMutator;
  /**
   * Phase-5 adapter **read** surface (AP-1 state, AP-5 health): the pooled reader over
   * `AdapterEndpoint`/`AdapterBinding` + the per-binding mapping/backend status the
   * read-time health derivation consults, plus the CONSUMER-operation enumeration behind
   * `not-yet-mapped`. Optional for the same reason as `adapterComposition`: the real
   * composition root always provides it; the in-memory unit harness omits it and the
   * AP-1/AP-5 routes are simply not registered.
   */
  readonly adapterState?: AdapterStateReader;
  /**
   * Phase-5 adapter request history (AP-5.1): the read side of the `adapter-request`
   * audit log, filtered by endpoint/binding/time. Optional for the same reason as
   * `adapterState`; metadata only (no payload, no token).
   */
  readonly adapterRequestHistory?: AdapterRequestHistoryReader;
  // Phase-4 Sync HTTP API (SA-1..SA-3): configure/enable/disable a `SyncRule`, read
  // sync state, and manually link/unlink records. Optional: the sync operator
  // surface is only mounted when the Sync Engine runtime is wired in (the real
  // composition root always provides it; the in-memory unit harness — which has no
  // sync runtime — legitimately omits it, and its routes are simply not registered).
  readonly sync?: SyncOperatorService;
  /**
   * TEST/DEV-ONLY: register the deterministic poll-trigger endpoint
   * (`POST /api/sync-rules/:id/poll`, the SP-5 hook the SU-6 e2e drives). Gated by the
   * `sync.testPollTrigger` config flag (env `SYNC_TEST_POLL_TRIGGER`, default false) —
   * it MUST stay off in production/dev. The route is registered only when this is `true`
   * **and** the sync runtime ({@link OperatorApiDeps.sync}) is present; otherwise the
   * route is absent and a request 404s. Absent/`false` here means not registered.
   */
  readonly syncTestPollTrigger?: boolean;
}

/**
 * The `:id` path parameter, shared by every entity-scoped route. Validated as a
 * UUID so a malformed id is a clean 400 at the boundary rather than reaching a
 * Drizzle `eq(<uuid column>, id)` and surfacing as a Postgres
 * `invalid input syntax for type uuid` 500. A well-formed-but-absent UUID still
 * falls through to a 404.
 */
export const idParamSchema = z.object({ id: z.uuid() });
