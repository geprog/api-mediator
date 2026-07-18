import type { ScopeCorrespondence, ScopeKey } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { canonicalScopeSides, scopeIdentitySignature } from "./canonical.js";
import {
  AMBIGUOUS_CONTAINER_DETAILS_PREFIX,
  formatAmbiguousContainerDetails,
  parseAmbiguousContainerDetails,
} from "./details.js";
import { FakeScopeLinkStore } from "./fakes.js";
import { ScopeDiscoveryStage } from "./scope-discovery-stage.js";
import type { ContainerParkReader, ScopeContainerCandidate } from "./types.js";
import { FakeSyncEventRecorder } from "../identity-resolution/fakes.js";

/**
 * Unit tests for SS-11 scope discovery — the engine invariants: canonical direction-
 * agnostic linking, both-enumerable + harvest identity-match establish, ambiguous → park
 * (never auto-link), on-demand inline resolution, idempotent establish, and never-write.
 */

// A source ("gitea") vs target ("vikunja") pair; source appId sorts BEFORE target so the
// canonical A/B assignment is deterministic and asserted below.
const SOURCE_APP = "app-gitea";
const TARGET_APP = "app-vikunja";
const PAIR = `${SOURCE_APP}:issues|${TARGET_APP}:tasks`;
const T0 = new Date("2026-07-18T00:00:00.000Z");

function correspondence(): ScopeCorrespondence {
  return {
    id: "corr-1",
    resourcePairRef: PAIR,
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: TARGET_APP, resourceRef: "projects" },
    sourceContainerRef: { appId: SOURCE_APP, resourceRef: "repos" },
    confirmedBy: "operator@example.test",
    confirmedAt: T0,
  };
}

function sourceCandidate(
  scopeKey: ScopeKey,
  signature: string,
  nativeId?: string,
): ScopeContainerCandidate {
  return { appId: SOURCE_APP, scopeKey, identitySignature: signature, nativeId };
}

function targetCandidate(
  scopeKey: ScopeKey,
  signature: string,
  nativeId: string,
): ScopeContainerCandidate {
  return { appId: TARGET_APP, scopeKey, identitySignature: signature, nativeId };
}

/** A stage with deterministic id/clock so events/links are assertable. */
function makeStage(parkReader?: ContainerParkReader): {
  stage: ScopeDiscoveryStage;
  links: FakeScopeLinkStore;
  events: FakeSyncEventRecorder;
} {
  const links = new FakeScopeLinkStore();
  const events = new FakeSyncEventRecorder();
  let counter = 0;
  const stage = new ScopeDiscoveryStage(
    { links, events, ...(parkReader !== undefined ? { parkReader } : {}) },
    { clock: (): Date => T0, newId: (): string => `id-${String((counter += 1))}` },
  );
  return { stage, links, events };
}

describe("canonicalScopeSides (direction-agnostic, one canonical link per container pair)", () => {
  it("assigns appA/appB by lexicographic appId — identical from either direction", () => {
    const fromSource = canonicalScopeSides({
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    const fromTarget = canonicalScopeSides({
      sourceAppId: TARGET_APP,
      sourceScopeKey: { id: "42" },
      targetAppId: SOURCE_APP,
      targetScopeKey: { owner: "alice", name: "phoenix" },
    });
    expect(fromSource).toStrictEqual(fromTarget);
    // The lexicographically-smaller appId is side A, carrying its own scope key.
    expect(fromSource.appAId).toBe(SOURCE_APP);
    expect(fromSource.appAScopeKey).toStrictEqual({ owner: "alice", name: "phoenix" });
    expect(fromSource.appBId).toBe(TARGET_APP);
    expect(fromSource.appBScopeKey).toStrictEqual({ id: "42" });
  });

  it("throws on a same-app (self-scope) pair — fail loud", () => {
    expect(() =>
      canonicalScopeSides({
        sourceAppId: SOURCE_APP,
        sourceScopeKey: { a: "1" },
        targetAppId: SOURCE_APP,
        targetScopeKey: { b: "2" },
      }),
    ).toThrow(/DIFFERENT apps/);
  });
});

describe("scopeIdentitySignature", () => {
  it("is order-of-values-sensitive but stable for equal value lists", () => {
    expect(scopeIdentitySignature(["phoenix"])).toBe(scopeIdentitySignature(["phoenix"]));
    expect(scopeIdentitySignature(["alice", "phoenix"])).not.toBe(
      scopeIdentitySignature(["phoenix", "alice"]),
    );
  });
});

describe("ambiguous-container details format/parse", () => {
  it("round-trips the machine payload", () => {
    const details = formatAmbiguousContainerDetails({
      resourcePairRef: PAIR,
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      candidateNativeIds: ["42", "43"],
    });
    expect(details.startsWith(AMBIGUOUS_CONTAINER_DETAILS_PREFIX)).toBe(true);
    expect(parseAmbiguousContainerDetails(details)).toStrictEqual({
      resourcePairRef: PAIR,
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      candidateNativeIds: ["42", "43"],
    });
  });

  it("returns undefined for a non-container / malformed details string", () => {
    expect(parseAmbiguousContainerDetails("ambiguous identity match: 2 candidates [a, b]")).toBe(
      undefined,
    );
    expect(parseAmbiguousContainerDetails(`${AMBIGUOUS_CONTAINER_DETAILS_PREFIX}: no tail`)).toBe(
      undefined,
    );
  });
});

describe("SS-11.1 establishConstant", () => {
  it("writes a canonical constant link, idempotent on re-run", async () => {
    const { stage, links, events } = makeStage();
    const first = await stage.establishConstant({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    expect(first.kind).toBe("created");
    const stored = links.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.establishedBy).toBe("constant");
    expect(stored[0]?.appAId).toBe(SOURCE_APP);
    expect(stored[0]?.appBScopeKey).toStrictEqual({ id: "42" });
    // A create records a success SyncEvent (SS-11.8).
    expect(events.all().filter((e) => e.status === "success")).toHaveLength(1);

    // Re-establishing the SAME pair is an idempotent no-op (no duplicate).
    const second = await stage.establishConstant({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    expect(second.kind).toBe("exists");
    expect(links.all()).toHaveLength(1);
  });

  it("refuses to re-point a container already linked to a different counterpart (conflict)", async () => {
    const { stage, links } = makeStage();
    await stage.establishConstant({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    const conflict = await stage.establishConstant({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "99" },
    });
    expect(conflict.kind).toBe("conflict");
    expect(links.all()).toHaveLength(1);
    expect(links.all()[0]?.appBScopeKey).toStrictEqual({ id: "42" });
  });
});

describe("SS-11.6 linkManually / unlink", () => {
  it("establishes a manual link and severs it (archive-not-delete)", async () => {
    const { stage, links } = makeStage();
    const result = await stage.linkManually({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    expect(result.kind).toBe("created");
    const id = result.kind === "created" ? result.link.id : "";
    expect(links.all()[0]?.establishedBy).toBe("manual");

    // Sever ARCHIVES (never deletes): the row survives, flipped to archived.
    expect(await stage.unlink(id)).toBe(true);
    expect(links.all()).toHaveLength(1);
    expect(links.all()[0]?.status).toBe("archived");
    // Severing an unknown id is a false no-op.
    expect(await stage.unlink("nope")).toBe(false);
  });
});

describe("SS-11.2 both-enumerable / SS-11.3 harvest — establishByIdentityMatch", () => {
  it("establishes identity-match links where the signatures match, leaves no-match unresolved", async () => {
    const { stage, links, events } = makeStage();
    const result = await stage.establishByIdentityMatch({
      correspondence: correspondence(),
      sourceCandidates: [
        sourceCandidate({ owner: "alice", name: "phoenix" }, "phoenix"),
        sourceCandidate({ owner: "bob", name: "atlas" }, "atlas"),
        sourceCandidate({ owner: "carol", name: "orphan" }, "orphan"),
      ],
      targetCandidates: [
        targetCandidate({ id: "42" }, "phoenix", "42"),
        targetCandidate({ id: "43" }, "atlas", "43"),
      ],
    });
    expect(result.established).toHaveLength(2);
    expect(result.established.every((l) => l.establishedBy === "identity-match")).toBe(true);
    expect(result.unresolved).toStrictEqual([{ owner: "carol", name: "orphan" }]);
    expect(result.ambiguous).toHaveLength(0);
    expect(links.all()).toHaveLength(2);
    // Each establish is an ordinary SyncEvent (SS-11.8).
    expect(events.all().filter((e) => e.status === "success")).toHaveLength(2);
  });

  it("parks an ambiguous container (identity value matches >1 target) — never auto-links (RL-4)", async () => {
    const { stage, links, events } = makeStage();
    const result = await stage.establishByIdentityMatch({
      correspondence: correspondence(),
      sourceCandidates: [sourceCandidate({ owner: "alice", name: "dup" }, "dup", "repo-1")],
      targetCandidates: [
        targetCandidate({ id: "42" }, "dup", "42"),
        targetCandidate({ id: "43" }, "dup", "43"),
      ],
    });
    expect(result.established).toHaveLength(0);
    expect(links.all()).toHaveLength(0); // NEVER auto-linked
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]?.candidateNativeIds).toStrictEqual(["42", "43"]);
    // A `failure` SyncEvent carrying the candidate containers is recorded (parked).
    const failure = events.all().find((e) => e.status === "failure");
    expect(failure?.details).toBeDefined();
    expect(parseAmbiguousContainerDetails(failure?.details ?? "")).toStrictEqual({
      resourcePairRef: PAIR,
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "dup" },
      candidateNativeIds: ["42", "43"],
    });
  });

  it("is idempotent — a second pass establishes nothing new (one canonical link per pair)", async () => {
    const { stage, links } = makeStage();
    const params = {
      correspondence: correspondence(),
      sourceCandidates: [sourceCandidate({ owner: "alice", name: "phoenix" }, "phoenix")],
      targetCandidates: [targetCandidate({ id: "42" }, "phoenix", "42")],
    };
    const first = await stage.establishByIdentityMatch(params);
    expect(first.established).toHaveLength(1);
    const second = await stage.establishByIdentityMatch(params);
    expect(second.established).toHaveLength(0);
    expect(second.alreadyLinked).toBe(1);
    expect(links.all()).toHaveLength(1);
  });

  it("harvest path — source candidates carry harvested captured scopes, matched to enumerated targets", async () => {
    const { stage, links } = makeStage();
    // Source not enumerable (Gitea): the source candidates come from harvested record scopes.
    const result = await stage.establishByIdentityMatch({
      correspondence: correspondence(),
      sourceCandidates: [
        sourceCandidate({ owner: "alice", name: "phoenix" }, "phoenix"),
        sourceCandidate({ owner: "alice", name: "phoenix" }, "phoenix"), // duplicate harvest
      ],
      targetCandidates: [targetCandidate({ id: "42" }, "phoenix", "42")],
    });
    expect(result.established).toHaveLength(1);
    expect(result.alreadyLinked).toBe(1); // the duplicate is an idempotent skip
    expect(links.all()).toHaveLength(1);
  });
});

describe("SS-11.4 resolveContainer (on-demand inline) / SS-11.5 park", () => {
  it("resolves an existing active link without re-establishing", async () => {
    const { stage } = makeStage();
    await stage.establishConstant({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    const outcome = await stage.resolveContainer({
      correspondence: correspondence(),
      source: {
        appId: SOURCE_APP,
        scopeKey: { owner: "alice", name: "phoenix" },
        identitySignature: "phoenix",
      },
      targetCandidates: [],
    });
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" && outcome.establishedNow).toBe(false);
  });

  it("establishes a link inline on a single match", async () => {
    const { stage, links } = makeStage();
    const outcome = await stage.resolveContainer({
      correspondence: correspondence(),
      source: {
        appId: SOURCE_APP,
        scopeKey: { owner: "alice", name: "phoenix" },
        identitySignature: "phoenix",
      },
      targetCandidates: [targetCandidate({ id: "42" }, "phoenix", "42")],
    });
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" && outcome.establishedNow).toBe(true);
    expect(links.all()).toHaveLength(1);
  });

  it("parks an ambiguous on-demand match (never guessed)", async () => {
    const { stage, links, events } = makeStage();
    const outcome = await stage.resolveContainer({
      correspondence: correspondence(),
      source: {
        appId: SOURCE_APP,
        scopeKey: { owner: "alice", name: "dup" },
        identitySignature: "dup",
      },
      targetCandidates: [
        targetCandidate({ id: "42" }, "dup", "42"),
        targetCandidate({ id: "43" }, "dup", "43"),
      ],
    });
    expect(outcome.kind).toBe("ambiguous");
    expect(links.all()).toHaveLength(0);
    expect(events.all().some((e) => e.status === "failure")).toBe(true);
  });

  it("parks an unresolvable (no target match) record — recorded, never dropped, never guessed", async () => {
    const { stage, links, events } = makeStage();
    const outcome = await stage.resolveContainer({
      correspondence: correspondence(),
      source: {
        appId: SOURCE_APP,
        scopeKey: { owner: "carol", name: "orphan" },
        identitySignature: "orphan",
      },
      targetCandidates: [targetCandidate({ id: "42" }, "phoenix", "42")],
    });
    expect(outcome.kind).toBe("unresolvable");
    expect(links.all()).toHaveLength(0);
    // Recorded as a `failure` park with an empty candidate list (never silently dropped).
    const failure = events.all().find((e) => e.status === "failure");
    expect(
      parseAmbiguousContainerDetails(failure?.details ?? "")?.candidateNativeIds,
    ).toStrictEqual([]);
  });
});

describe("SS-11.6 operator override — a severed (archived) container is not auto-re-linked", () => {
  it("establishByIdentityMatch skips a source container the operator severed (no re-link, no park)", async () => {
    const { stage, links, events } = makeStage();
    // Establish then sever (archive) a link for the source container.
    const established = await stage.linkManually({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    await stage.unlink(established.kind === "created" ? established.link.id : "");

    // A sweep re-matches the same source to the same target — but the archive is an override.
    const result = await stage.establishByIdentityMatch({
      correspondence: correspondence(),
      sourceCandidates: [sourceCandidate({ owner: "alice", name: "phoenix" }, "phoenix", "repo-1")],
      targetCandidates: [targetCandidate({ id: "42" }, "phoenix", "42")],
    });
    expect(result.overridden).toStrictEqual([{ owner: "alice", name: "phoenix" }]);
    expect(result.established).toHaveLength(0);
    // No NEW active link (only the archived one remains) and no park event minted.
    expect(links.all().filter((l) => l.status === "active")).toHaveLength(0);
    expect(events.all().some((e) => e.status === "failure")).toBe(false);
  });

  it("resolveContainer parks (does not re-link) a record for a severed container", async () => {
    const { stage, links } = makeStage();
    const established = await stage.linkManually({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    await stage.unlink(established.kind === "created" ? established.link.id : "");

    const outcome = await stage.resolveContainer({
      correspondence: correspondence(),
      source: {
        appId: SOURCE_APP,
        scopeKey: { owner: "alice", name: "phoenix" },
        identitySignature: "phoenix",
      },
      targetCandidates: [targetCandidate({ id: "42" }, "phoenix", "42")],
    });
    expect(outcome.kind).toBe("unresolvable"); // never auto-re-linked
    expect(links.all().filter((l) => l.status === "active")).toHaveLength(0);
  });

  it("a manual re-link overrides the override — a fresh active link is created", async () => {
    const { stage, links } = makeStage();
    const established = await stage.linkManually({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "42" },
    });
    await stage.unlink(established.kind === "created" ? established.link.id : "");

    const relink = await stage.linkManually({
      correspondence: correspondence(),
      sourceAppId: SOURCE_APP,
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: TARGET_APP,
      targetScopeKey: { id: "99" },
    });
    expect(relink.kind).toBe("created");
    expect(links.all().filter((l) => l.status === "active")).toHaveLength(1);
  });
});

describe("SS-11.7 park dedup — one open park entry per (pair, scope key), not N per sweep", () => {
  /** A park reader that reports a given (pair, scope key) as already open. */
  function openParkReader(eventId: string, forScopeKey: ScopeKey): ContainerParkReader {
    return {
      findOpenContainerPark: (resourcePairRef, scopeKey): Promise<string | undefined> =>
        Promise.resolve(
          resourcePairRef === PAIR && JSON.stringify(scopeKey) === JSON.stringify(forScopeKey)
            ? eventId
            : undefined,
        ),
    };
  }

  it("reuses an existing open park's event id and mints NO new failure event", async () => {
    const scopeKey = { owner: "alice", name: "dup" };
    const { stage, events } = makeStage(openParkReader("existing-event", scopeKey));

    const outcome = await stage.resolveContainer({
      correspondence: correspondence(),
      source: { appId: SOURCE_APP, scopeKey, identitySignature: "dup" },
      targetCandidates: [
        targetCandidate({ id: "42" }, "dup", "42"),
        targetCandidate({ id: "43" }, "dup", "43"),
      ],
    });
    expect(outcome.kind).toBe("ambiguous");
    expect(outcome.kind === "ambiguous" && outcome.syncEventId).toBe("existing-event");
    // Deduped: no new `failure` SyncEvent was recorded.
    expect(events.all()).toHaveLength(0);
  });

  it("still mints a fresh park event when none is open for the key", async () => {
    const { stage, events } = makeStage(
      openParkReader("existing-event", { owner: "x", name: "y" }),
    );
    await stage.resolveContainer({
      correspondence: correspondence(),
      source: {
        appId: SOURCE_APP,
        scopeKey: { owner: "alice", name: "dup" },
        identitySignature: "dup",
      },
      targetCandidates: [
        targetCandidate({ id: "42" }, "dup", "42"),
        targetCandidate({ id: "43" }, "dup", "43"),
      ],
    });
    expect(events.all().filter((e) => e.status === "failure")).toHaveLength(1);
  });
});
