import { describe, expect, it } from "vitest";

import {
  peerPeerDetailContext,
  consumerProviderDetailContext,
  shortlistContext,
} from "./fixtures.js";
import {
  buildDetailPrompt,
  buildShortlistPrompt,
  PROMPT_VERSION,
  type ChatMessage,
} from "./prompt.js";

function joinContent(messages: readonly ChatMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

function systemMessage(messages: readonly ChatMessage[]): string {
  return messages.find((message) => message.role === "system")?.content ?? "";
}

describe("PROMPT_VERSION", () => {
  it("is a stable non-empty identifier", () => {
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

describe("buildShortlistPrompt", () => {
  it("encodes the recall bias (TD-1.4): when in doubt, include the pair", () => {
    const system = systemMessage(buildShortlistPrompt(shortlistContext));
    expect(system).toMatch(/recall-biased/i);
    expect(system).toMatch(/when in doubt/i);
    expect(system).toMatch(/include the pair/i);
    // The rationale — a false negative is worse than a false positive — is present.
    expect(system).toMatch(/false negative/i);
  });

  it("templates only resource metadata (names, descriptions, operation summaries, fields)", () => {
    const content = joinContent(buildShortlistPrompt(shortlistContext));
    expect(content).toContain("Issues");
    expect(content).toContain("Gitea issues on a repository");
    expect(content).toContain("List repository issues");
    expect(content).toContain("Tasks");
    // Top-level field names are metadata and appear; nothing else is available to leak.
    expect(content).toContain("title");
  });

  it("appends corrective feedback only when present", () => {
    const withoutFeedback = buildShortlistPrompt(shortlistContext);
    expect(withoutFeedback.filter((m) => m.role === "user")).toHaveLength(1);

    const withFeedback = buildShortlistPrompt({
      ...shortlistContext,
      correctiveFeedback: "candidatePairs.0.confidence: expected number",
    });
    const content = joinContent(withFeedback);
    expect(content).toContain("failed schema validation");
    expect(content).toContain("candidatePairs.0.confidence: expected number");
  });
});

describe("buildDetailPrompt", () => {
  it("requests the peer-peer shape: identityCandidate, no phase/parameterMappings", () => {
    const system = systemMessage(buildDetailPrompt(peerPeerDetailContext));
    expect(system).toMatch(/PEER-PEER/);
    expect(system).toContain("identityCandidate");
    expect(system).toMatch(/do NOT include a `phase`/i);
    expect(system).toMatch(/do NOT produce `parameterMappings`/i);
  });

  it("requests the consumer-provider shape: phase + parameterMappings, no identityCandidate", () => {
    const system = systemMessage(buildDetailPrompt(consumerProviderDetailContext));
    expect(system).toMatch(/CONSUMER-PROVIDER/);
    expect(system).toContain("phase");
    expect(system).toContain("parameterMappings");
    expect(system).toMatch(/do NOT flag `identityCandidate`/i);
  });

  it("templates only resource metadata (operations + schema fields)", () => {
    const content = joinContent(buildDetailPrompt(peerPeerDetailContext));
    expect(content).toContain("issueListIssues");
    expect(content).toContain("getProjectTasks");
    expect(content).toContain("title");
  });

  it("appends corrective feedback only when present", () => {
    const withoutFeedback = buildDetailPrompt(peerPeerDetailContext);
    expect(withoutFeedback.filter((m) => m.role === "user")).toHaveLength(1);

    const withFeedback = buildDetailPrompt({
      ...peerPeerDetailContext,
      correctiveFeedback: "fieldMappings: at most one identityCandidate",
    });
    const content = joinContent(withFeedback);
    expect(content).toContain("failed schema validation");
    expect(content).toContain("fieldMappings: at most one identityCandidate");
  });
});
