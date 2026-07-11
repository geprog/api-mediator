import type { IrResourceGroup } from "@mediator/domain";

import type {
  MappingPromptContext,
  ResourceSummary,
  ShortlistPromptContext,
  SpecSummaryIR,
} from "./provider.js";

/**
 * Prompt templating for both detection stages, owned by this package so every
 * provider sends identical prompts (LP-1 crit 5). Two properties are load-bearing
 * and directly asserted by the unit tests:
 *
 * - the shortlist prompt is **recall-biased** — "when in doubt, include the pair"
 *   (TD-1 crit 4);
 * - the detail prompt requests the **variant-correct** output shape — peer-peer
 *   asks for `identityCandidate` and forbids `phase`/`parameterMappings`;
 *   consumer-provider asks for `phase` + `parameterMappings` and forbids
 *   `identityCandidate` (TD-2 crit 4/5).
 *
 * `correctiveFeedback`, when present on the context, is appended as a final user
 * message so the engine's corrective retry re-prompts with the prior validation
 * error (TD-3). `promptVersion` is threaded through the context and stamped into
 * `generatedBy`; {@link PROMPT_VERSION} is the stable handle these templates ship.
 *
 * Security (LLM data boundary, `docs/architecture/security.md`): only spec
 * metadata is ever templated. The context types carry nothing but IR metadata
 * (names, descriptions, types, summaries) — there is no credential or live-record
 * field to leak — and the renderers below read only those metadata fields.
 */

/** A single chat message sent to the model. */
export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/**
 * The stable identifier of the prompt templates in this slice, stamped into
 * `generatedBy.promptVersion` (LP-4). Bump it when either stage's template text
 * changes so proposals stay comparable across prompt revisions.
 */
export const PROMPT_VERSION = "mapping-2026-07-v2";

// ── Stage 1: shortlist ───────────────────────────────────────────────────────

const SHORTLIST_SYSTEM_PROMPT = [
  "You are the shortlist stage of an API mapping engine.",
  "You are given resource-level summaries of two API specifications, a SOURCE and a TARGET.",
  "Shortlist every pair of resources — one from the source, one from the target — that plausibly",
  "describe the same real-world concept and could therefore correspond.",
  "",
  "Work SYSTEMATICALLY. Take each SOURCE resource in turn and scan ALL TARGET resources for it",
  "before moving on to the next source resource. Do NOT stop early: consider every source resource",
  "against every target resource, even when the lists are long.",
  "",
  "Be RECALL-BIASED: when in doubt, INCLUDE the pair. A false positive costs only one wasted",
  "detail analysis downstream, but a false negative means a real correspondence is never proposed",
  "at all. A miss is far more costly than a spurious pair — prefer over-inclusion to omission.",
  "",
  "ALWAYS pair resources whose `resourceRef` names are identical or obvious synonyms — for example",
  "labels↔labels, comments↔comments, users↔user, tags↔labels. Pairing an identically-named resource",
  "is mandatory, never optional. ALSO pair semantically-equivalent records whose names differ — for",
  "example issues↔tasks, customers↔contacts, invoices↔bills. Matching the underlying concept matters",
  "more than matching the spelling.",
  "",
  "Each resource is listed as its display name followed by its `resourceRef` in parentheses. Copy",
  "the `sourceResource` and `targetResource` values VERBATIM from those `resourceRef` strings: use",
  "the exact ref shown (not the display name), and never invent a ref, never prefix or annotate it,",
  "and never emit a name that does not appear in the provided source/target lists.",
  "",
  "Resource correspondence is direction-agnostic. Return only the JSON object required by the",
  "schema: a `candidatePairs` array, each entry with `sourceResource`, `targetResource`,",
  "a `confidence` in [0,1], and a short `rationale`. Return an empty array only when genuinely",
  "nothing corresponds.",
].join("\n");

function renderResourceSummary(summary: ResourceSummary): string {
  const lines = [`- ${summary.name} (resourceRef: ${summary.resourceRef})`];
  if (summary.description !== undefined && summary.description.length > 0) {
    lines.push(`  description: ${summary.description}`);
  }
  if (summary.operationSummaries.length > 0) {
    lines.push(`  operations: ${summary.operationSummaries.join("; ")}`);
  }
  if (summary.topLevelFields.length > 0) {
    lines.push(`  fields: ${summary.topLevelFields.join(", ")}`);
  }
  return lines.join("\n");
}

function renderSpecSummary(spec: SpecSummaryIR): string {
  if (spec.length === 0) {
    return "(no in-scope resources)";
  }
  return spec.map(renderResourceSummary).join("\n");
}

/**
 * Build the stage-1 shortlist messages. Recall-biased system prompt + the two
 * specs' resource summaries; a corrective-feedback message is appended when the
 * context carries one.
 */
export function buildShortlistPrompt(context: ShortlistPromptContext): readonly ChatMessage[] {
  const userContent = [
    "Source spec resources (summaries):",
    renderSpecSummary(context.sourceSpecSummaryIR),
    "",
    "Target spec resources (summaries):",
    renderSpecSummary(context.targetSpecSummaryIR),
    "",
    "Shortlist the plausibly-corresponding resource pairs.",
  ].join("\n");

  return withCorrectiveFeedback(
    [
      { role: "system", content: SHORTLIST_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    context.correctiveFeedback,
  );
}

// ── Stage 2: detail ──────────────────────────────────────────────────────────

const DETAIL_SYSTEM_PROMPT_COMMON = [
  "You are the detail stage of an API mapping engine, analyzing ONE pair of corresponding",
  "resources. Produce operation-level and field-level correspondences from the SOURCE resource",
  "to the TARGET resource.",
  "",
  "For every operation and field: give a `confidence` strictly in the range [0,1] (never below 0 or",
  "above 1), a `rationale`, populate `ambiguousAlternatives` when more than one target is plausible",
  "(never silently best-guess), and set `unmapped: true` (with a null target) when no counterpart",
  "exists.",
  "",
  "Copy every operation id and field name — `sourceOperationId`, `targetOperationId`, `sourceField`,",
  "`targetField` — VERBATIM from the operations and schemas shown below. Never invent, rename, or",
  "annotate an id or field name; use the exact strings provided.",
].join("\n");

const DETAIL_SYSTEM_PROMPT_PEER_PEER = [
  DETAIL_SYSTEM_PROMPT_COMMON,
  "",
  "This is a PEER-PEER mapping (data sync between two providers):",
  "- Flag AT MOST ONE field pairing as `identityCandidate: true` — the business key whose raw",
  "  values identify the SAME record in both apps (email, SKU, order number, …). Only a",
  "  value-preserving pairing qualifies: an identity candidate may carry no transform beyond",
  "  `rename`. Where the target's collection read exposes a lookup parameter for that field,",
  "  name it as `targetLookupParamRef`.",
  "- Do NOT include a `phase` on any field, and do NOT produce `parameterMappings` — a peer-peer",
  "  mapping has a single data direction.",
].join("\n");

const DETAIL_SYSTEM_PROMPT_CONSUMER_PROVIDER = [
  DETAIL_SYSTEM_PROMPT_COMMON,
  "",
  "This is a CONSUMER-PROVIDER mapping (the source is a consumer's wished-for API served from the",
  "target backend provider):",
  "- Every field correspondence MUST carry a `phase`: `request` (consumer request in → backend",
  "  request out) or `response` (backend response in → consumer response out). The two phases are",
  "  independent transform sets, not inverses of each other.",
  "- Produce `parameterMappings` for the path/query/header parameters of each operation pair.",
  "- Do NOT flag `identityCandidate` — the adapter never correlates records across apps.",
  "Emit both phases and the parameter mappings from THIS single response.",
].join("\n");

/**
 * Render the two full resources as metadata-only JSON. `IrResourceGroup` is
 * metadata by domain construction (operations, parameters, and flattened schema
 * fields — no live values), so serializing it cannot cross the LLM data boundary.
 */
function renderResource(role: string, resource: IrResourceGroup): string {
  return `${role} resource (full operations + schemas):\n${JSON.stringify(resource, null, 2)}`;
}

/**
 * Build the stage-2 detail messages for the context's `variant`. The system
 * prompt is variant-specific (so the requested output shape matches the variant's
 * `format`); the user message carries both resources in full; corrective feedback
 * is appended when present.
 */
export function buildDetailPrompt(context: MappingPromptContext): readonly ChatMessage[] {
  const systemContent =
    context.variant === "peer-peer"
      ? DETAIL_SYSTEM_PROMPT_PEER_PEER
      : DETAIL_SYSTEM_PROMPT_CONSUMER_PROVIDER;

  const userContent = [
    renderResource("SOURCE", context.sourceResourceIR),
    "",
    renderResource("TARGET", context.targetResourceIR),
    "",
    "Produce the correspondences required by the schema.",
  ].join("\n");

  return withCorrectiveFeedback(
    [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    context.correctiveFeedback,
  );
}

// ── Corrective retry re-prompt (TD-3) ────────────────────────────────────────

function withCorrectiveFeedback(
  messages: readonly ChatMessage[],
  correctiveFeedback: string | undefined,
): readonly ChatMessage[] {
  if (correctiveFeedback === undefined || correctiveFeedback.length === 0) {
    return messages;
  }
  const correction: ChatMessage = {
    role: "user",
    content: [
      "Your previous response failed schema validation with the following error(s):",
      correctiveFeedback,
      "Return a corrected response that conforms exactly to the required schema.",
    ].join("\n"),
  };
  return [...messages, correction];
}
