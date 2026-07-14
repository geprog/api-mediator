import { z } from "zod";

import type { ExclusionsReplacer } from "../../modules/analysis-exclusions.js";
import type {
  ApprovalService,
  EscapeHatchService,
  ProposalReadService,
} from "../../modules/approval/index.js";
import type { AppReader, BindingReader, SpecReader } from "../../modules/persistence.js";
import type { Registrar } from "../../modules/registration.js";
import type { BindingConfirmer } from "../../modules/resource-bindings.js";
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
  readonly exclusionsReplacer: ExclusionsReplacer;
  // Phase-3 Review & Approval (RA-1..RA-5): the read side, the Approval Service
  // (per-item decisions + identity-key confirmation + approve), and the
  // shortlist-miss escape hatch.
  readonly proposalReadService: ProposalReadService;
  readonly approvalService: ApprovalService;
  readonly escapeHatchService: EscapeHatchService;
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
