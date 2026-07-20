import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  AppCapabilities,
  ConfirmableRef,
  IrResourceGroup,
  OperationMapping,
  RecordLink,
  ResourceBinding,
} from "@mediator/domain";
import { resolveRecordAddressing } from "@mediator/domain";
import type {
  DecryptedCredential,
  UsableCredentialSecret,
  WithCredentialResult,
} from "@mediator/credentials";
import { buildIr, deriveResourceBindings } from "@mediator/ir";
import { beforeAll, describe, expect, it } from "vitest";

import { resolveWriteOperationBinding } from "./binding-resolvers.js";
import {
  OutboundCallExecutor,
  type CredentialAccess,
  type OutboundCall,
  type OutboundCallCommon,
} from "./executor.js";
import { AppLoadGovernor } from "./load-governor.js";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "./protocol-client.js";
import { FakeSyncEventStore } from "./sync-event-store.js";

/**
 * **SS-19 — the two identities of a container-scoped record**, driven end-to-end through
 * the **real** derivation → **real** binding resolver → **real** Outbound Call Executor,
 * over the **real** vendored Gitea spec (`scenario-2`) that produced the live Layer-3
 * capstone failure. Nothing here is faked except the wire itself (a capturing
 * `ProtocolClient`) and the credential scope — the URL under assertion is composed by
 * production code from a production spec.
 *
 * The bug this locks down: a Gitea issue carries **both** a globally-unique `id` and a
 * repo-relative `number`, and `PATCH /repos/{owner}/{repo}/issues/{index}` addresses by
 * the latter. Before SS-19 the write composed `/repos/alice/phoenix/issues/<globalId>`
 * and 404'd; choosing `number` as the `nativeIdRef` instead would have fixed the URL and
 * broken linking, because repo A's #1 and repo B's #1 collide.
 *
 * The assertions therefore always check **both halves at once**: the URL carries the
 * container-relative address, *and* the `RecordLink` still stores/links by the global id.
 */

const CONFIRMED_AT = new Date("2026-07-21T00:00:00.000Z");
const NOW = new Date("2026-07-21T12:00:00.000Z");
const TRACE = { traceId: "trace-ss19", spanId: "span-ss19" };

/** The real Gitea issue that produced the live failure: global id 4242, repo-relative #7. */
const GLOBAL_ID = "4242";
const CONTAINER_ADDRESS = "7";

const GITEA_SPEC_PATH = fileURLToPath(
  new URL(
    "../../../scenarios/scenario-2-multi-overlap/specs/oas3/gitea.trimmed.oas3.json",
    import.meta.url,
  ),
);

// ── Fakes: the wire and the credential scope only ─────────────────────────────

class CapturingProtocolClient implements ProtocolClient {
  public readonly requests: OutboundRequest[] = [];

  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    return Promise.resolve({ status: 200, body: { id: 4242, number: 7 }, headers: {} });
  }
}

class StubCredentialAccess implements CredentialAccess {
  public async withCredential<T>(
    _appId: string,
    fn: (credential: DecryptedCredential) => Promise<T>,
  ): Promise<WithCredentialResult<T>> {
    const secret: UsableCredentialSecret = { type: "apiKey", apiKey: "test-token" };
    const value = await fn({ credentialId: "cred-1", type: "apiKey", scopes: [], secret });
    return { outcome: "invoked", value };
  }
}

// ── Builders ──────────────────────────────────────────────────────────────────

function caps(): AppCapabilities {
  return {
    supportsPolling: true,
    supportsDeltaQuery: false,
    supportsChangeTimestamps: true,
    defaultPollInterval: 60_000,
  };
}

function confirm(ref: ConfirmableRef): ConfirmableRef {
  return { value: ref.value, confirmedBy: "operator", confirmedAt: CONFIRMED_AT };
}

/**
 * The `issues` binding as an operator would leave it after RB-3: every ref confirmed,
 * and the two scope path parameters supplied as confirmed `constant`s naming one repo.
 * `withAddressRef = false` models a resource that addresses by its native id (and, byte
 * for byte, every binding that predates SS-19 — the ref key is simply absent).
 */
function confirmedIssuesBinding(
  base: ResourceBinding,
  owner: string,
  repo: string,
  withAddressRef: boolean,
): ResourceBinding {
  const { recordAddressRef, ...rest } = base;
  const nativeIdRef = base.nativeIdRef;
  if (nativeIdRef === undefined || recordAddressRef === undefined) {
    throw new Error("fixture drift: the Gitea issues binding must derive both refs");
  }
  return {
    ...rest,
    nativeIdRef: confirm(nativeIdRef),
    ...(withAddressRef ? { recordAddressRef: confirm(recordAddressRef) } : {}),
    scopePathBindings: [
      {
        kind: "constant",
        parameterName: "owner",
        value: owner,
        confirmedBy: "operator",
        confirmedAt: CONFIRMED_AT,
      },
      {
        kind: "constant",
        parameterName: "repo",
        value: repo,
        confirmedBy: "operator",
        confirmedAt: CONFIRMED_AT,
      },
    ],
  };
}

// `resourceRef/operationId` (+ `#parameter`), exactly as the approval layer stores them.
const UPDATE_ID_PARAM_REF = "issues/issueEditIssue#index";

function updateOperationMapping(): OperationMapping {
  return {
    id: "op-update",
    mappingId: "map-1",
    sourceOperationRef: "tasks/get /tasks",
    targetOperationRef: "issues/issueEditIssue",
    action: "update",
    targetIdParamRef: UPDATE_ID_PARAM_REF,
  };
}

/**
 * A link exactly as Identity Resolution establishes it under SS-19: correlated by the two
 * sides' **global** native ids, with the container-relative address frozen alongside.
 */
function link(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: "link-1",
    appAId: "app-vikunja",
    appANativeId: "task-99",
    appBId: "app-gitea",
    appBNativeId: GLOBAL_ID,
    appBRecordAddress: CONTAINER_ADDRESS,
    resourcePairRef: "pair-1",
    establishedBy: "create-propagation",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "Ship it" },
    createdAt: NOW,
    tombstonedAt: null,
    ...overrides,
  };
}

function executor(protocol: ProtocolClient): OutboundCallExecutor {
  return new OutboundCallExecutor(
    protocol,
    new StubCredentialAccess(),
    new FakeSyncEventStore(),
    new AppLoadGovernor({ now: () => 0 }),
    { now: () => NOW, readTraceContext: () => TRACE },
  );
}

/**
 * Compose the update call the pipeline handler builds: the **real** resolved write op,
 * the link's **global** native id (identity + idempotency), and the address the handler
 * resolved from the link (`undefined` on a native-id-addressed target).
 */
function updateCall(
  binding: ResourceBinding,
  group: IrResourceGroup,
  recordLink: RecordLink,
  targetRecordAddress: string | undefined,
): OutboundCall {
  const operation = resolveWriteOperationBinding(updateOperationMapping(), group, binding);
  if (operation === undefined) {
    throw new Error("the real resolver refused to resolve the Gitea issue update op");
  }
  const common: OutboundCallCommon = {
    targetAppId: "app-gitea",
    baseUrl: "https://gitea.test/api/v1",
    operation,
    operationMapping: updateOperationMapping(),
    sourceNativeId: recordLink.appANativeId,
    targetResourceNativeIdRef: { kind: "field", path: "id" },
    relatedRuleId: "rule-1",
    recordLinkId: recordLink.id,
  };
  return {
    ...common,
    action: "update",
    payload: { title: "Ship it" },
    priorReconciledState: { kind: "none" },
    // Identity — what the link stores and what keys idempotency.
    targetNativeId: recordLink.appBNativeId,
    // Addressing — what fills `{index}`.
    ...(targetRecordAddress !== undefined ? { targetRecordAddress } : {}),
  };
}

// ── The suite ─────────────────────────────────────────────────────────────────

describe("SS-19 container-relative record addressing (real Gitea spec, real resolver, real executor)", () => {
  let issuesGroup: IrResourceGroup;
  let derivedIssues: ResourceBinding;

  beforeAll(async () => {
    const ir = await buildIr(readFileSync(GITEA_SPEC_PATH, "utf8"));
    const group = ir.find((candidate) => candidate.resourceRef === "issues");
    expect(group).toBeDefined();
    issuesGroup = group as IrResourceGroup;
    const derived = deriveResourceBindings(ir, caps(), "spec-gitea").find(
      (candidate) => candidate.resourceRef === "issues",
    );
    expect(derived).toBeDefined();
    derivedIssues = derived as ResourceBinding;
  });

  it("RB-1/SS-19.1: derives the address ref as `number` — distinct from `nativeIdRef` — and leaves it UNCONFIRMED", () => {
    // The two identities are derived as two separate refs off the same real schema.
    expect(derivedIssues.nativeIdRef?.value).toEqual({ kind: "field", path: "id" });
    expect(derivedIssues.recordAddressRef?.value).toEqual({ kind: "field", path: "number" });

    // Derive-then-confirm: nothing auto-confirms the addressing ref.
    expect(derivedIssues.recordAddressRef?.confirmedBy).toBeNull();
    expect(derivedIssues.recordAddressRef?.confirmedAt).toBeNull();

    // ...and while it is unconfirmed on this container-scoped resource, the decision is
    // the loud one, never a silent pick of either identifier.
    expect(resolveRecordAddressing(derivedIssues, true)).toEqual({
      kind: "unconfirmed-address-ref",
    });
  });

  it("SS-19.3: a scoped update addresses `/repos/{owner}/{repo}/issues/<number>` while the RecordLink still stores the GLOBAL id", async () => {
    const binding = confirmedIssuesBinding(derivedIssues, "alice", "phoenix", true);
    expect(resolveRecordAddressing(binding, true)).toEqual({ kind: "stored-address" });

    const recordLink = link();
    const protocol = new CapturingProtocolClient();
    const result = await executor(protocol).execute(
      updateCall(binding, issuesGroup, recordLink, recordLink.appBRecordAddress),
    );

    expect(result.outcome).toBe("success");
    const request = protocol.requests[0];
    expect(request).toBeDefined();
    // The container-relative address fills `{index}` — this is the URL that 404'd before.
    expect(request?.url).toBe("https://gitea.test/api/v1/repos/alice/phoenix/issues/7");
    expect(request?.method).toBe("PATCH");
    // The global id NEVER appears in the addressed URL.
    expect(request?.url).not.toContain(GLOBAL_ID);

    // ...and the link is untouched: it still correlates by the global id on both sides.
    expect(recordLink.appBNativeId).toBe(GLOBAL_ID);
    expect(recordLink.appBRecordAddress).toBe(CONTAINER_ADDRESS);
  });

  it("SS-19.3: a scoped delete routes by the stored address too (no source record needed)", async () => {
    const binding = confirmedIssuesBinding(derivedIssues, "alice", "phoenix", true);
    const deleteMapping: OperationMapping = {
      id: "op-delete",
      mappingId: "map-1",
      sourceOperationRef: "tasks/get /tasks",
      targetOperationRef: "issues/issueDelete",
      action: "delete",
      targetIdParamRef: "issues/issueDelete#index",
    };
    const operation = resolveWriteOperationBinding(deleteMapping, issuesGroup, binding);
    if (operation === undefined) {
      throw new Error("the real resolver refused to resolve the Gitea issue delete op");
    }

    const recordLink = link();
    const protocol = new CapturingProtocolClient();
    const result = await executor(protocol).execute({
      targetAppId: "app-gitea",
      baseUrl: "https://gitea.test/api/v1",
      operation,
      operationMapping: deleteMapping,
      sourceNativeId: recordLink.appANativeId,
      targetResourceNativeIdRef: { kind: "field", path: "id" },
      recordLinkId: recordLink.id,
      action: "delete",
      // The delete has no live source record — both the container and the address come
      // from stored `RecordLink` state. That is the whole point of freezing them.
      targetNativeId: recordLink.appBNativeId,
      ...(recordLink.appBRecordAddress !== undefined
        ? { targetRecordAddress: recordLink.appBRecordAddress }
        : {}),
    });

    expect(result.outcome).toBe("success");
    expect(protocol.requests[0]?.url).toBe(
      "https://gitea.test/api/v1/repos/alice/phoenix/issues/7",
    );
    expect(protocol.requests[0]?.method).toBe("DELETE");
  });

  it("SS-19: a same-numbered record in a DIFFERENT container is never addressed — id and scope stay separate slots (SS-12.5)", async () => {
    // Two records that collide on their container-relative address (#1 in both repos) but
    // are globally distinct. This is precisely the merge that choosing `number` as the
    // `nativeIdRef` would have caused.
    const inPhoenix = link({
      id: "link-phoenix",
      appBNativeId: "5001",
      appBRecordAddress: "1",
    });
    const inAtlas = link({ id: "link-atlas", appBNativeId: "9002", appBRecordAddress: "1" });

    const phoenixProtocol = new CapturingProtocolClient();
    await executor(phoenixProtocol).execute(
      updateCall(
        confirmedIssuesBinding(derivedIssues, "alice", "phoenix", true),
        issuesGroup,
        inPhoenix,
        inPhoenix.appBRecordAddress,
      ),
    );
    const atlasProtocol = new CapturingProtocolClient();
    await executor(atlasProtocol).execute(
      updateCall(
        confirmedIssuesBinding(derivedIssues, "bob", "atlas", true),
        issuesGroup,
        inAtlas,
        inAtlas.appBRecordAddress,
      ),
    );

    const phoenixUrl = phoenixProtocol.requests[0]?.url;
    const atlasUrl = atlasProtocol.requests[0]?.url;
    // Same address, different containers → different records. Each write stays inside the
    // container its own `RecordLink` resolved.
    expect(phoenixUrl).toBe("https://gitea.test/api/v1/repos/alice/phoenix/issues/1");
    expect(atlasUrl).toBe("https://gitea.test/api/v1/repos/bob/atlas/issues/1");
    expect(phoenixUrl).not.toBe(atlasUrl);
    // Neither call ever reaches into the other's container.
    expect(phoenixUrl).not.toContain("atlas");
    expect(atlasUrl).not.toContain("phoenix");
    // The links remain distinct by global id — the address collision never merged them.
    expect(inPhoenix.appBNativeId).not.toBe(inAtlas.appBNativeId);
  });

  it("SS-19.4 regression: with NO addressing ref confirmed, composition is byte-for-byte the pre-SS-19 native-id URL", async () => {
    const binding = confirmedIssuesBinding(derivedIssues, "alice", "phoenix", false);
    // No ref at all → the native-id decision, exactly as every pre-SS-19 binding resolves.
    expect(binding.recordAddressRef).toBeUndefined();
    expect(resolveRecordAddressing(binding, true)).toEqual({ kind: "native-id" });

    const recordLink = link({ appBRecordAddress: undefined });
    const protocol = new CapturingProtocolClient();
    const result = await executor(protocol).execute(
      // The handler resolves `undefined` for a native-id-addressed target.
      updateCall(binding, issuesGroup, recordLink, undefined),
    );

    expect(result.outcome).toBe("success");
    // The GLOBAL id fills `{index}` — the old (broken-for-Gitea, but correct everywhere
    // else) behavior, reproduced exactly. This is the compatibility contract.
    expect(protocol.requests[0]?.url).toBe(
      `https://gitea.test/api/v1/repos/alice/phoenix/issues/${GLOBAL_ID}`,
    );
  });

  it("SS-19.4: an unscoped resource with an unconfirmed address ref stays on native-id addressing (never blocked)", () => {
    // Condition 4 of `resolveRecordAddressing`: with no container, an unratified candidate
    // is inert rather than a blocker — an unscoped resource is never penalised for it.
    expect(resolveRecordAddressing(derivedIssues, false)).toEqual({ kind: "native-id" });
  });
});
