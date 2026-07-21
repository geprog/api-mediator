import type { RecordLink } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  buildLinkGroups,
  RecordLinkUnionLinkResolver,
  type LinkEdge,
  type RecordLinkLookup,
  type UnionLinkContributor,
} from "./union-links.js";

function contributor(
  bindingId: string,
  backendAppId: string,
  backendResourceRef: string,
  nativeIds: readonly (string | undefined)[],
): UnionLinkContributor {
  return { bindingId, backendAppId, backendResourceRef, nativeIds };
}

describe("buildLinkGroups — AG-3.3 pure union-find", () => {
  it("paired rows across two backends share a canonical group key; unlinked rows are undefined", () => {
    const contributors = [
      contributor("a", "backend-a", "tasks", ["A1", "A2"]),
      contributor("b", "backend-b", "issues", ["B1"]),
    ];
    const edges: LinkEdge[] = [
      { a: { appId: "backend-a", nativeId: "A1" }, b: { appId: "backend-b", nativeId: "B1" } },
    ];
    const groups = buildLinkGroups(contributors, edges);
    const a = groups.get("a") ?? [];
    const b = groups.get("b") ?? [];
    // A1 and B1 share a group; A2 is unlinked.
    expect(a[0]).toBeDefined();
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBeUndefined();
  });

  it("is transitive across ≥3 backends (A↔B, B↔C ⇒ one group) and edge-order independent", () => {
    const contributors = [
      contributor("a", "app-a", "r", ["A"]),
      contributor("b", "app-b", "r", ["B"]),
      contributor("c", "app-c", "r", ["C"]),
    ];
    const edgesForward: LinkEdge[] = [
      { a: { appId: "app-a", nativeId: "A" }, b: { appId: "app-b", nativeId: "B" } },
      { a: { appId: "app-b", nativeId: "B" }, b: { appId: "app-c", nativeId: "C" } },
    ];
    const g1 = buildLinkGroups(contributors, edgesForward);
    const g2 = buildLinkGroups(contributors, [...edgesForward].reverse());
    const key1 = g1.get("a")?.[0];
    expect(key1).toBeDefined();
    expect(g1.get("b")?.[0]).toBe(key1);
    expect(g1.get("c")?.[0]).toBe(key1);
    // Canonical key is the same regardless of the order edges were folded in.
    expect(g2.get("a")?.[0]).toBe(key1);
  });

  it("a row with no native-id provenance is never grouped", () => {
    const groups = buildLinkGroups([contributor("a", "app-a", "r", [undefined])], []);
    expect(groups.get("a")).toEqual([undefined]);
  });
});

describe("RecordLinkUnionLinkResolver — AG-3.3 DB edge derivation", () => {
  function link(
    appAId: string,
    appANativeId: string,
    appBId: string,
    appBNativeId: string,
  ): RecordLink {
    return {
      id: "link-1",
      appAId,
      appANativeId,
      appBId,
      appBNativeId,
      resourcePairRef: "ignored",
      establishedBy: "manual",
      status: "active",
      establishingQueueKey: { kind: "both-native-id-queues" },
      createdAt: new Date(),
      tombstonedAt: null,
    };
  }

  it("resolves a link into a shared group key across the two contributors", async () => {
    const lookup: RecordLinkLookup = {
      findActiveByRecord: (_pairRef, record) =>
        Promise.resolve(
          record.appId === "backend-a" && record.nativeId === "A1"
            ? link("backend-a", "A1", "backend-b", "B1")
            : undefined,
        ),
    };
    const resolver = new RecordLinkUnionLinkResolver(lookup);
    const groups = await resolver.resolve([
      contributor("a", "backend-a", "tasks", ["A1"]),
      contributor("b", "backend-b", "issues", ["B1"]),
    ]);
    expect(groups.get("a")?.[0]).toBeDefined();
    expect(groups.get("a")?.[0]).toBe(groups.get("b")?.[0]);
  });

  it("two bindings on the SAME backend app never link (not sync peers)", async () => {
    let calls = 0;
    const lookup: RecordLinkLookup = {
      findActiveByRecord: () => {
        calls += 1;
        return Promise.resolve(undefined);
      },
    };
    const resolver = new RecordLinkUnionLinkResolver(lookup);
    const groups = await resolver.resolve([
      contributor("a", "same-app", "tasks", ["A1"]),
      contributor("b", "same-app", "issues", ["B1"]),
    ]);
    expect(calls).toBe(0); // same-app pairs are skipped entirely.
    expect(groups.get("a")).toEqual([undefined]);
  });
});
