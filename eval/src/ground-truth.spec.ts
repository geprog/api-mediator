import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseGroundTruth } from "./ground-truth.js";
import { scenariosRoot } from "./scenario-loader.js";

/**
 * Parser tests over the REAL vendored `ground-truth.yaml` fixtures — proving the
 * parser handles the actual fixture shapes (peer-peer CRUD ops, identity keys,
 * `plausible` false-positives, and the consumer-provider request/response +
 * constant-synthesis shape), not just a hand-built sample.
 */

function readGroundTruth(scenario: string): string {
  return readFileSync(path.join(scenariosRoot(), scenario, "ground-truth.yaml"), "utf8");
}

describe("parseGroundTruth — real scenario-1 (peer-peer)", () => {
  const gt = parseGroundTruth(readGroundTruth("scenario-1-small-overlap"));

  it("parses the four resource pairs and five negatives", () => {
    expect(gt.scenario).toBe("scenario-1-small-overlap");
    expect(gt.pairs).toHaveLength(4);
    expect(gt.negatives).toHaveLength(5);
    expect(gt.pairs.every((p) => p.kind === "peer-peer")).toBe(true);
  });

  it("parses the issues↔tasks pair with its identity key and CRUD operations", () => {
    const issues = gt.pairs.find((p) => p.kind === "peer-peer" && p.sourceResource === "issues");
    expect(issues?.kind).toBe("peer-peer");
    if (issues?.kind !== "peer-peer") throw new Error("expected peer-peer");
    expect(issues.identityKey).toEqual({ source: "title", target: "title" });
    // Operations are parsed to METHOD/path identity, not raw strings.
    expect(issues.operations.get("create")?.source).toEqual({
      method: "POST",
      path: "/repos/{owner}/{repo}/issues",
    });
    expect(issues.operations.get("create")?.target).toEqual({
      method: "PUT",
      path: "/projects/{id}/tasks",
    });
    // The `plausible` false-positive (number ↔ index) is preserved.
    expect(issues.plausibleFields).toContainEqual({
      source: "number",
      target: "index",
      transform: null,
    });
    expect(issues.unmappedSources).toContain("milestone");
  });

  it("parses a keyless pair with a null identity key (comments)", () => {
    const comments = gt.pairs.find(
      (p) => p.kind === "peer-peer" && p.sourceResource === "issue-comments",
    );
    if (comments?.kind !== "peer-peer") throw new Error("expected peer-peer");
    expect(comments.identityKey).toEqual({ source: null, target: null });
  });

  it("parses the negatives with their verdicts", () => {
    const tempting = gt.negatives.find((n) => n.verdict === "incorrect-but-tempting");
    expect(tempting?.source).toEqual({ kind: "resource", app: "gitea", resource: "milestones" });
    expect(tempting?.target).toEqual({ kind: "resource", app: "vikunja", resource: "buckets" });
    expect(gt.negatives.filter((n) => n.verdict === "no-counterpart")).toHaveLength(3);
    expect(gt.negatives.some((n) => n.verdict === "ambiguous")).toBe(true);
  });
});

describe("parseGroundTruth — real scenario-3 (consumer-provider)", () => {
  const gt = parseGroundTruth(readGroundTruth("scenario-3-consumer-provider"));

  it("parses the consumer-provider pair with its operations and phases", () => {
    expect(gt.pairs).toHaveLength(1);
    const pair = gt.pairs[0];
    if (pair?.kind !== "consumer-provider") throw new Error("expected consumer-provider");
    expect(pair.targetApps).toEqual(["vikunja"]);
    expect(pair.operations).toHaveLength(3);

    // The request-phase constant-synthesis case: a null source → a synthesized target.
    const complete = pair.operations.find((op) => op.consumer.path === "/todos/{todoId}/complete");
    expect(complete?.requestFields).toContainEqual({
      source: null,
      target: "done",
      transform: "expression",
    });
    // Response-phase field pairs are parsed.
    const list = pair.operations.find((op) => op.consumer.path === "/todos");
    expect(list?.responseFields).toContainEqual({
      source: "id",
      target: "todoId",
      transform: "coerce",
    });
    expect(list?.parameters.length).toBeGreaterThan(0);
  });
});
