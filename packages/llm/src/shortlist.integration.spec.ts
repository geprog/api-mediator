import type { MappingLlmConfig } from "@mediator/config";
import { describe, expect, it } from "vitest";

import { OllamaProvider } from "./ollama-provider.js";
import type { ShortlistPromptContext } from "./provider.js";

/**
 * OPTIONAL live-Ollama smoke — NOT part of `pnpm verify`. It hits a real Ollama
 * with a tiny two-resource pair and asserts the provider returns a schema-valid
 * `ResourceShortlist` (the provider only resolves on a validated shape, so a
 * resolution *is* the schema assertion). Run it with:
 *
 *   pnpm --filter @mediator/llm test:integration
 *
 * It self-skips when Ollama is unreachable, so a box without the model running
 * is a skip, never a failure.
 */

const baseUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
const model = process.env["MAPPING_LLM_MODEL"] ?? "glm-4.7-flash:latest";

async function isOllamaReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const reachable = await isOllamaReachable();

const config: MappingLlmConfig = {
  provider: "ollama",
  ollamaBaseUrl: baseUrl,
  model,
  temperature: 0,
  thinking: (process.env["MAPPING_LLM_THINKING"] ?? "true") === "true",
  requestTimeoutMs: 110_000,
  maxRetries: 3,
};

const context: ShortlistPromptContext = {
  sourceSpecSummaryIR: [
    {
      resourceRef: "customers",
      name: "Customers",
      description: "People who buy things",
      operationSummaries: ["List customers", "Get a customer"],
      topLevelFields: ["id", "name", "email"],
    },
    {
      resourceRef: "invoices",
      name: "Invoices",
      description: "Amounts billed to customers",
      operationSummaries: ["List invoices"],
      topLevelFields: ["id", "total", "customerId"],
    },
  ],
  targetSpecSummaryIR: [
    {
      resourceRef: "contacts",
      name: "Contacts",
      description: "Address-book people",
      operationSummaries: ["List contacts"],
      topLevelFields: ["id", "displayName", "emailAddress"],
    },
    {
      resourceRef: "bills",
      name: "Bills",
      description: "Money owed by a contact",
      operationSummaries: ["List bills"],
      topLevelFields: ["id", "amount", "contactId"],
    },
  ],
  promptVersion: "integration-smoke",
};

describe.skipIf(!reachable)("OllamaProvider — live shortlist smoke", () => {
  it("returns a schema-valid ResourceShortlist for a tiny two-resource pair", async () => {
    const provider = new OllamaProvider({ config });
    const shortlist = await provider.shortlistResourcePairs(context);
    expect(Array.isArray(shortlist.candidatePairs)).toBe(true);
    for (const pair of shortlist.candidatePairs) {
      expect(typeof pair.sourceResource).toBe("string");
      expect(typeof pair.targetResource).toBe("string");
      expect(pair.confidence).toBeGreaterThanOrEqual(0);
      expect(pair.confidence).toBeLessThanOrEqual(1);
    }
  });
});
