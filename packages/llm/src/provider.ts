import type {
  GeneratedBy,
  IrResourceGroup,
  MappingSuggestionSet,
  MappingVariant,
  ResourceShortlist,
} from "@mediator/domain";

/**
 * The pluggable `LLMMappingProvider` seam (LP-1) — the single interface the
 * Mapping Engine core depends on for both detection stages. The core owns prompt
 * templating, validation, retry, and repair; a provider owns exactly one thing:
 * turning one prompt context into one validated structured stage output.
 *
 * The interface exposes **exactly two methods** (LP-1 crit 1), named verbatim
 * from `docs/architecture/mapping-engine.md` "Pluggable LLM provider interface".
 * Provider **identity** (`providerId`, `model`) is exposed as read-only
 * properties — not extra methods — so the core, depending only on this interface,
 * can stamp `generatedBy` on a proposal (see {@link buildGeneratedBy}) without
 * knowing which concrete provider is active (LP-1 crit 4, LP-4).
 *
 * Both methods perform exactly ONE model call each and then validate the output
 * (see the errors module): they resolve with the typed value on success and
 * reject with `LLMOutputValidationError` (malformed output) or `LLMTransportError`
 * (unreachable model / timeout). The corrective-retry LOOP that reacts to those
 * rejections is the engine's job, deliberately NOT in this slice.
 */
export interface LLMMappingProvider {
  /** Stable provider identity recorded into `generatedBy.providerId` (LP-4). */
  readonly providerId: string;
  /** The model identifier recorded into `generatedBy.model` (LP-4). */
  readonly model: string;

  /** Stage 1: shortlist plausibly-corresponding resource pairs (one call). */
  shortlistResourcePairs(context: ShortlistPromptContext): Promise<ResourceShortlist>;

  /** Stage 2: detail-analyze one shortlisted resource pair (one call). */
  generateMappingProposal(context: MappingPromptContext): Promise<MappingSuggestionSet>;
}

// ── Stage-1 context: resource-level summaries only ───────────────────────────

/**
 * The lightweight summary of one resource group fed to the shortlist stage:
 * name, description, operation summaries, and the top-level field list — the
 * same summary form the IR decomposition already produces for cross-resource
 * references (see `docs/architecture/mapping-engine.md` "Spec decomposition").
 *
 * Deliberately **metadata only**, and deliberately NOT the full operations or
 * schemas — the shortlist call must stay cheap, and the LLM data boundary
 * (`docs/architecture/security.md`) forbids anything but spec metadata reaching
 * the model. The Mapping Engine builds these from the IR; the provider only
 * templates them.
 */
export interface ResourceSummary {
  /** The `IrResourceGroup.resourceRef` this summary stands for. */
  readonly resourceRef: string;
  readonly name: string;
  readonly description?: string;
  /** One entry per operation: its `summary` (or a fallback label). */
  readonly operationSummaries: readonly string[];
  /** The distinct top-level field names across the resource's schemas. */
  readonly topLevelFields: readonly string[];
}

/** One spec's in-scope resources, as summaries (stage-1 input side). */
export type SpecSummaryIR = readonly ResourceSummary[];

/**
 * Stage-1 prompt context. Carries only resource-level summaries of both specs'
 * in-scope resources plus the active `promptVersion` (LP-1 crit 2).
 * `correctiveFeedback`, when present, is the prior attempt's validation error
 * that the engine re-prompts with (TD-3); a provider call is still ONE attempt.
 */
export interface ShortlistPromptContext {
  readonly sourceSpecSummaryIR: SpecSummaryIR;
  readonly targetSpecSummaryIR: SpecSummaryIR;
  readonly promptVersion: string;
  readonly correctiveFeedback?: string;
}

// ── Stage-2 context: the two full resources ──────────────────────────────────

/**
 * A previously-edited mapping for this app pair, fed back to inform future
 * proposals (`priorFeedback` in the concept's interface). **Always absent in
 * Phase 2** (LP-1 crit 3): re-mapping on spec change supplies it in Phase 6, and
 * only the engine's templating will consume it then. Modeled metadata-only so it
 * can never smuggle live data across the LLM boundary.
 */
export interface PriorMappingFeedback {
  readonly sourceRef: string;
  readonly targetRef: string | null;
  readonly note: string;
}

/**
 * Stage-2 prompt context. Carries both resources' **full** operations and
 * schemas (the domain `IrResourceGroup`, which is metadata-only by construction),
 * the `variant` the core already knows from the pair's spec roles, and the active
 * `promptVersion` (LP-1 crit 3).
 *
 * - `correctiveFeedback` — the prior attempt's validation error the engine
 *   re-prompts with on a corrective retry (TD-3). One call is one attempt.
 * - `priorFeedback` — Phase-6 re-mapping input; always absent in Phase 2 and not
 *   templated by this slice.
 */
export interface MappingPromptContext {
  readonly sourceResourceIR: IrResourceGroup;
  readonly targetResourceIR: IrResourceGroup;
  readonly variant: MappingVariant;
  readonly promptVersion: string;
  readonly correctiveFeedback?: string;
  readonly priorFeedback?: readonly PriorMappingFeedback[];
}

// ── Provenance (LP-4) ────────────────────────────────────────────────────────

/**
 * Assemble the `generatedBy` provenance a proposal is stamped with (LP-4): the
 * active provider's identity (`providerId`, `model`) plus the caller's active
 * `promptVersion` (the single handle covering both stage prompts). Kept a pure
 * helper over the interface's identity properties so the engine can stamp
 * provenance while depending on nothing provider-specific (LP-1 crit 4).
 */
export function buildGeneratedBy(
  provider: Pick<LLMMappingProvider, "providerId" | "model">,
  promptVersion: string,
): GeneratedBy {
  return { providerId: provider.providerId, model: provider.model, promptVersion };
}
