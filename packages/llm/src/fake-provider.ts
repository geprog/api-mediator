import type { MappingSuggestionSet, ResourceShortlist } from "@mediator/domain";

import type {
  LLMMappingProvider,
  LlmUsage,
  MappingPromptContext,
  ShortlistPromptContext,
} from "./provider.js";
import { validateShortlistContent, validateSuggestionSetContent } from "./schemas.js";

/**
 * Synthetic, deterministic zero usage the fake reports for every call — enough
 * for the engine to thread a usage record without any real model timing.
 */
const FAKE_USAGE: LlmUsage = { promptEvalCount: 0, evalCount: 0 };

/**
 * `FakeProvider` (LP-3) — a deterministic, network-free `LLMMappingProvider` for
 * the engine's mechanical unit/e2e tests and offline runs. It returns scripted
 * raw outputs keyed by input, then runs them through the **same** validators as
 * {@link OllamaProvider} (via `JSON.stringify` → `validate*Content`) so its
 * parse-then-validate boundary is byte-for-byte the real provider's:
 *
 * - script a **valid** result → the method resolves with exactly that value;
 * - script a **malformed** raw shape → the method throws `LLMOutputValidationError`,
 *   exactly as the real provider would on malformed model output (drives the
 *   engine's corrective retry — TD-3);
 * - script **per-pair** results, and **per-attempt** sequences.
 *
 * ## Scripting model
 *
 * Each stage is a map from a context key to a **queue** of raw outputs. A queue
 * is consumed with a clamped cursor: call N returns entry `min(N, len - 1)`, so
 * - `[valid]` → `valid` on every call (a stable fixed result);
 * - `[malformed, valid]` → `malformed`, then `valid` forever (malformed-then-valid
 *   retry — LP-3 crit 3);
 * - `[malformed]` → `malformed` on every call (malformed-to-the-ceiling — LP-3
 *   crit 4).
 *
 * The default key derivations are the resource-refs of the input; override them
 * (`shortlistKey` / `detailKey`) for finer control. Provider identity
 * (`providerId` / `model`) is scriptable so provenance tests can assert it (LP-3
 * crit 5, LP-4).
 */

/**
 * A scripted raw output — the value the fake "returns from the model" before
 * validation. A valid stage output (a `ResourceShortlist` / `MappingSuggestionSet`)
 * passes; any other shape is rejected by the shared validator, exactly as a
 * malformed real answer would be.
 */
export type ScriptedOutput = unknown;

export interface FakeProviderScript {
  /** Recorded into `generatedBy.providerId` (default `"fake"`). */
  readonly providerId?: string;
  /** Recorded into `generatedBy.model` (default `"fake-model"`). */
  readonly model?: string;
  /** Stage-1 raw outputs, keyed by {@link FakeProviderScript.shortlistKey}. */
  readonly shortlist?: Readonly<Record<string, readonly ScriptedOutput[]>>;
  /** Stage-2 raw outputs, keyed by {@link FakeProviderScript.detailKey}. */
  readonly detail?: Readonly<Record<string, readonly ScriptedOutput[]>>;
  /** Override the stage-1 key derivation (default: source vs. target resource refs). */
  readonly shortlistKey?: (context: ShortlistPromptContext) => string;
  /** Override the stage-2 key derivation (default: `sourceRef=>targetRef@variant`). */
  readonly detailKey?: (context: MappingPromptContext) => string;
}

/** Thrown when a provider method is called with no scripted output for its key. */
export class FakeProviderScriptError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FakeProviderScriptError";
  }
}

function defaultShortlistKey(context: ShortlistPromptContext): string {
  const source = context.sourceSpecSummaryIR.map((resource) => resource.resourceRef).join(",");
  const target = context.targetSpecSummaryIR.map((resource) => resource.resourceRef).join(",");
  return `${source}=>${target}`;
}

function defaultDetailKey(context: MappingPromptContext): string {
  return `${context.sourceResourceIR.resourceRef}=>${context.targetResourceIR.resourceRef}@${context.variant}`;
}

export class FakeProvider implements LLMMappingProvider {
  public readonly providerId: string;
  public readonly model: string;
  /** Synthetic usage of the most recent call — see {@link LLMMappingProvider.lastUsage}. */
  public lastUsage: LlmUsage | undefined = undefined;
  private readonly shortlistScript: Readonly<Record<string, readonly ScriptedOutput[]>>;
  private readonly detailScript: Readonly<Record<string, readonly ScriptedOutput[]>>;
  private readonly shortlistKey: (context: ShortlistPromptContext) => string;
  private readonly detailKey: (context: MappingPromptContext) => string;
  private readonly cursors = new Map<string, number>();

  public constructor(script: FakeProviderScript = {}) {
    this.providerId = script.providerId ?? "fake";
    this.model = script.model ?? "fake-model";
    this.shortlistScript = script.shortlist ?? {};
    this.detailScript = script.detail ?? {};
    this.shortlistKey = script.shortlistKey ?? defaultShortlistKey;
    this.detailKey = script.detailKey ?? defaultDetailKey;
  }

  // The bodies run inside a deferred `.then` so a scripting error or a validation
  // failure surfaces as a rejected promise (matching the provider contract),
  // never a synchronous throw.
  public shortlistResourcePairs(context: ShortlistPromptContext): Promise<ResourceShortlist> {
    return Promise.resolve().then(() => {
      // Report synthetic usage even on a malformed (validation-failing) attempt —
      // it "reached the model" and, like the real provider, the thrown error must
      // not erase the attempt's usage.
      this.lastUsage = FAKE_USAGE;
      const key = this.shortlistKey(context);
      const raw = this.nextScripted("shortlist", key, this.shortlistScript[key]);
      return validateShortlistContent(JSON.stringify(raw));
    });
  }

  public generateMappingProposal(context: MappingPromptContext): Promise<MappingSuggestionSet> {
    return Promise.resolve().then(() => {
      this.lastUsage = FAKE_USAGE;
      const key = this.detailKey(context);
      const raw = this.nextScripted("detail", key, this.detailScript[key]);
      return validateSuggestionSetContent(JSON.stringify(raw), context.variant);
    });
  }

  /** Dequeue the next scripted output for a key with a clamped, repeating cursor. */
  private nextScripted(
    stage: string,
    key: string,
    queue: readonly ScriptedOutput[] | undefined,
  ): ScriptedOutput {
    if (queue === undefined || queue.length === 0) {
      throw new FakeProviderScriptError(
        `FakeProvider has no scripted ${stage} output for key "${key}"`,
      );
    }
    const cursorKey = `${stage}:${key}`;
    const attempt = this.cursors.get(cursorKey) ?? 0;
    this.cursors.set(cursorKey, attempt + 1);
    return queue[Math.min(attempt, queue.length - 1)];
  }
}
