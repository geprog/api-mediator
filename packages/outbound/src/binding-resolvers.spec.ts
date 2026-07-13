import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  ApiSpec,
  ApprovedMapping,
  AppCapabilities,
  ConfirmableRef,
  IrField,
  IrParameter,
  IrResourceGroup,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";
import type {
  DecryptedCredential,
  UsableCredentialSecret,
  WithCredentialResult,
} from "@mediator/credentials";
import { buildIr, deriveResourceBindings } from "@mediator/ir";
import { hashFieldValue } from "@mediator/sync-engine";
import type { SingleRecordReadBinding as CfReadBinding } from "@mediator/sync-engine";
import { readPath, type JsonRecord, type JsonValue } from "@mediator/transform";
import { beforeAll, describe, expect, it } from "vitest";

import {
  RepoRestSourceBindingResolver,
  resolveSingleRecordRead,
  resolveSingleRecordReadBinding,
  resolveSourceReadBinding,
  resolveWriteOperationBinding,
  type ApiSpecReader,
  type ApprovedMappingReader,
  type BindingResolverRepositories,
  type OperationMappingReader,
  type RegisteredAppReader,
  type ResolvedSingleRecordRead,
  type ResourceBindingReader,
  type SingleRecordReadResolver,
  type SourceReadBindingInput,
  type SyncRuleReader,
} from "./binding-resolvers.js";
import type { CredentialAccess, CredentialApplier } from "./executor.js";
import { AppLoadGovernor } from "./load-governor.js";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "./protocol-client.js";
import { RestSingleRecordTargetReader } from "./rest-single-record-reader.js";

/**
 * Unit tests for the Sync-Engine binding resolvers — the IR + confirmed
 * `ResourceBinding` refs → concrete REST wire shapes. Fixtures come from the vendored
 * scenario-1 Vikunja spec (the sync capstone pair; realistic synthetic operationIds
 * and page/`per_page` pagination) plus hand-built IR for edge cases (offset paging,
 * delta cursor + deletion, a query-located id parameter). The load-bearing assertions:
 * an **unconfirmed** ref never yields a fabricated binding, and a single-record read's
 * returned representation **round-trips** through `hashFieldValue` against a seeded
 * baseline.
 */

// ── Shared helpers ─────────────────────────────────────────────────────────────

const CONFIRMED_AT = new Date("2026-07-13T00:00:00.000Z");

function confirm(ref: ConfirmableRef): ConfirmableRef {
  return { value: ref.value, confirmedBy: "operator", confirmedAt: CONFIRMED_AT };
}

const REF_KEYS = [
  "nativeIdRef",
  "collectionReadRef",
  "paginationRef",
  "deltaCursorRef",
  "deltaDeletionRef",
  "changeTimestampRef",
] as const;

/** Confirm every present ref of a binding (an operator ratifying the derived guesses). */
function confirmBinding(binding: ResourceBinding): ResourceBinding {
  const out: ResourceBinding = { ...binding };
  for (const key of REF_KEYS) {
    const ref = out[key];
    if (ref !== undefined) {
      out[key] = confirm(ref);
    }
  }
  return out;
}

function caps(overrides: Partial<AppCapabilities> = {}): AppCapabilities {
  return {
    supportsPolling: true,
    supportsDeltaQuery: false,
    supportsChangeTimestamps: true,
    defaultPollInterval: 60_000,
    ...overrides,
  };
}

function rule(overrides: Partial<SyncRule> = {}): SyncRule {
  return {
    id: "rule-1",
    approvedMappingId: "mapping-1",
    resourcePairRef: "app-src:tasks|app-tgt:issues",
    status: "enabled",
    ...overrides,
  };
}

const SOURCE_INPUT_BASE = {
  sourceAppId: "app-src",
  baseUrl: "https://vikunja.test",
} as const;

function param(name: string, location: IrParameter["location"]): IrParameter {
  return { name, location, required: location === "path" };
}

function field(name: string, type: string): IrField {
  return { name, type, required: false };
}

/** Read a field value exactly as Conflict Detection does (absent → null), for hashing. */
function pathValue(record: JsonRecord, path: string): JsonValue {
  const read = readPath(record, path);
  return read.present ? read.value : null;
}

// ── 1. Full-fetch source-read binding from the scenario Vikunja spec ────────────

describe("resolveSourceReadBinding — full-fetch (scenario Vikunja tasks: page-number)", () => {
  let tasksGroup: IrResourceGroup;
  let tasksBinding: ResourceBinding;

  beforeAll(async () => {
    const specPath = fileURLToPath(
      new URL(
        "../../../scenarios/scenario-1-small-overlap/specs/oas3/vikunja.trimmed.oas3.json",
        import.meta.url,
      ),
    );
    const ir = await buildIr(readFileSync(specPath, "utf8"));
    const group = ir.find((g) => g.resourceRef === "tasks");
    expect(group).toBeDefined();
    tasksGroup = group as IrResourceGroup;
    const derived = deriveResourceBindings(ir, caps(), "spec-vikunja");
    const binding = derived.find((b) => b.resourceRef === "tasks");
    expect(binding).toBeDefined();
    tasksBinding = confirmBinding(binding as ResourceBinding);
  });

  it("resolves method/path from collectionReadRef, native id, page-number pagination with per_page limit", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps(),
      sourceGroup: tasksGroup,
      sourceBinding: tasksBinding,
    });
    expect(result).toBeDefined();
    expect(result?.method).toBe("GET");
    expect(result?.path).toBe("/tasks");
    expect(result?.nativeIdPath).toBe("id");
    // GET /tasks returns a top-level array (decompose unwraps to the item schema whose
    // sub-collections `assignees`/`labels` must NOT be mistaken for the records wrapper).
    expect(result?.recordsPath).toBeUndefined();
    expect(result?.pagination).toEqual({
      kind: "page-number",
      pageParam: "page",
      limitParam: "per_page",
      pageSize: 100,
      startPage: 1,
    });
    expect(result?.delta).toBeUndefined();
  });

  it("honors an explicit pollOperationRef that resolves in the source group", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule({ pollOperationRef: "tasks/get /tasks" }),
      sourceCapabilities: caps(),
      sourceGroup: tasksGroup,
      sourceBinding: tasksBinding,
    });
    expect(result?.method).toBe("GET");
    expect(result?.path).toBe("/tasks");
  });

  it("carries the source app's outbound ceilings when present", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      limits: { maxConcurrentRequests: 2, maxRequestsPerWindow: 10, rateWindowMs: 1000 },
      sourceCapabilities: caps(),
      sourceGroup: tasksGroup,
      sourceBinding: tasksBinding,
    });
    expect(result?.limits).toEqual({
      maxConcurrentRequests: 2,
      maxRequestsPerWindow: 10,
      rateWindowMs: 1000,
    });
  });

  it("resolves the single-record read + its wire shape from the same group", () => {
    const readBinding = resolveSingleRecordReadBinding(tasksGroup, tasksBinding);
    expect(readBinding).toEqual({ readOperationId: "get /tasks/{id}", idParamRef: "id" });
    const resolved = resolveSingleRecordRead({
      binding: readBinding as CfReadBinding,
      targetGroup: tasksGroup,
      baseUrl: "https://vikunja.test",
    });
    expect(resolved).toEqual({
      baseUrl: "https://vikunja.test",
      method: "GET",
      pathTemplate: "/tasks/{id}",
      idLocation: { name: "id", in: "path" },
    });
  });
});

// ── 2. Offset pagination (hand-built IR) ────────────────────────────────────────

function offsetGroup(
  overrides: { parameters?: IrParameter[]; responseFields?: IrField[] } = {},
): IrResourceGroup {
  return {
    resourceRef: "customers",
    name: "customers",
    operations: [
      {
        operationId: "listCustomers",
        method: "get",
        path: "/customers",
        parameters: overrides.parameters ?? [param("offset", "query"), param("limit", "query")],
        responseSchema: {
          name: "Customer",
          fields: overrides.responseFields ?? [field("id", "string"), field("name", "string")],
        },
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

function offsetBinding(): ResourceBinding {
  return confirmBinding({
    id: "rb-off",
    apiSpecId: "spec-off",
    resourceRef: "customers",
    nativeIdRef: unconfirmedField("id"),
    collectionReadRef: unconfirmedOperation("listCustomers"),
    paginationRef: unconfirmedParameter("listCustomers", "offset"),
  });
}

function unconfirmedField(path: string): ConfirmableRef {
  return { value: { kind: "field", path }, confirmedBy: null, confirmedAt: null };
}
function unconfirmedOperation(operationId: string): ConfirmableRef {
  return { value: { kind: "operation", operationId }, confirmedBy: null, confirmedAt: null };
}
function unconfirmedParameter(operationId: string, parameter: string): ConfirmableRef {
  return {
    value: { kind: "parameter", operationId, parameter },
    confirmedBy: null,
    confirmedAt: null,
  };
}

describe("resolveSourceReadBinding — offset pagination + limitParam presence", () => {
  it("produces an offset convention with a sibling limit param (a full page is detectable)", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps(),
      sourceGroup: offsetGroup(),
      sourceBinding: offsetBinding(),
    });
    expect(result?.pagination).toEqual({
      kind: "offset",
      offsetParam: "offset",
      limitParam: "limit",
      pageSize: 100,
    });
    // A top-level-array item schema (has `id`) → the body IS the array.
    expect(result?.recordsPath).toBeUndefined();
  });

  it("omits limitParam when the operation exposes no limit-like parameter (single param only)", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps(),
      sourceGroup: offsetGroup({ parameters: [param("offset", "query")] }),
      sourceBinding: offsetBinding(),
    });
    // A `toEqual` with no `limitParam` key asserts its absence (the SP invariant edge).
    expect(result?.pagination).toEqual({ kind: "offset", offsetParam: "offset", pageSize: 100 });
  });

  it("respects a configured defaultPageSize", () => {
    const result = resolveSourceReadBinding(
      {
        ...SOURCE_INPUT_BASE,
        rule: rule(),
        sourceCapabilities: caps(),
        sourceGroup: offsetGroup(),
        sourceBinding: offsetBinding(),
      },
      { defaultPageSize: 25 },
    );
    expect(result?.pagination).toEqual({
      kind: "offset",
      offsetParam: "offset",
      limitParam: "limit",
      pageSize: 25,
    });
  });

  it("resolves recordsPath to a `data` wrapper field when records are NOT top-level", () => {
    // A wrapper object (no native id at top level) → recordsPath points at the array field.
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps(),
      sourceGroup: offsetGroup({
        responseFields: [field("data", "Customer[]"), field("total", "integer")],
      }),
      sourceBinding: offsetBinding(),
    });
    expect(result?.recordsPath).toBe("data");
  });
});

// ── 3. Delta polling (hand-built IR) ────────────────────────────────────────────

function deltaGroup(): IrResourceGroup {
  return {
    resourceRef: "orders",
    name: "orders",
    operations: [
      {
        operationId: "listOrderChanges",
        method: "get",
        path: "/orders",
        parameters: [param("since", "query"), param("page", "query"), param("limit", "query")],
        responseSchema: {
          name: "Order",
          fields: [field("id", "string"), field("status", "string"), field("deletedAt", "string")],
        },
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

function deltaBinding(): ResourceBinding {
  return confirmBinding({
    id: "rb-delta",
    apiSpecId: "spec-delta",
    resourceRef: "orders",
    nativeIdRef: unconfirmedField("id"),
    collectionReadRef: unconfirmedOperation("listOrderChanges"),
    paginationRef: unconfirmedParameter("listOrderChanges", "page"),
    deltaCursorRef: unconfirmedParameter("listOrderChanges", "since"),
    deltaDeletionRef: unconfirmedField("deletedAt"),
  });
}

describe("resolveSourceReadBinding — delta polling (cursor + deletion convention)", () => {
  it("produces a delta convention with the cursor param and a marker-field deletion", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps({ supportsDeltaQuery: true }),
      sourceGroup: deltaGroup(),
      sourceBinding: deltaBinding(),
    });
    expect(result?.delta).toEqual({
      cursorParam: "since",
      nextCursorPath: "since",
      deletion: { kind: "marker-field", markerPath: "deletedAt", deletedWhenEquals: true },
    });
    // The delta read does not page; pagination is a non-paging placeholder.
    expect(result?.pagination).toEqual({ kind: "single-page" });
  });

  it("honors a configured deltaNextCursorPath and deletedWhenEquals sentinel", () => {
    const result = resolveSourceReadBinding(
      {
        ...SOURCE_INPUT_BASE,
        rule: rule(),
        sourceCapabilities: caps({ supportsDeltaQuery: true }),
        sourceGroup: deltaGroup(),
        sourceBinding: deltaBinding(),
      },
      { deltaNextCursorPath: "meta.next", deletedWhenEquals: "gone" },
    );
    expect(result?.delta?.nextCursorPath).toBe("meta.next");
    expect(result?.delta?.deletion).toEqual({
      kind: "marker-field",
      markerPath: "deletedAt",
      deletedWhenEquals: "gone",
    });
  });

  it("omits delta.deletion when deltaDeletionRef is unconfirmed (SP-3.3 — no fabricated deletions)", () => {
    const binding = deltaBinding();
    binding.deltaDeletionRef = unconfirmedField("deletedAt"); // present but NOT confirmed
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps({ supportsDeltaQuery: true }),
      sourceGroup: deltaGroup(),
      sourceBinding: binding,
    });
    expect(result?.delta?.cursorParam).toBe("since");
    expect(result?.delta?.deletion).toBeUndefined();
  });

  it("stays full-fetch (no delta) when the app does NOT declare supportsDeltaQuery", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps({ supportsDeltaQuery: false }),
      sourceGroup: deltaGroup(),
      sourceBinding: deltaBinding(),
    });
    expect(result?.delta).toBeUndefined();
    expect(result?.pagination).toEqual({
      kind: "page-number",
      pageParam: "page",
      limitParam: "limit",
      pageSize: 100,
      startPage: 1,
    });
  });
});

// ── 4. Never fabricate a binding from an unconfirmed / missing ref ──────────────

describe("resolveSourceReadBinding — unconfirmed / missing refs never fabricate", () => {
  function inputWith(
    binding: ResourceBinding,
    capsOverride?: Partial<AppCapabilities>,
  ): SourceReadBindingInput {
    return {
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps(capsOverride),
      sourceGroup: offsetGroup(),
      sourceBinding: binding,
    };
  }

  it("returns undefined when nativeIdRef is unconfirmed", () => {
    const binding = offsetBinding();
    binding.nativeIdRef = unconfirmedField("id"); // un-confirm it
    expect(resolveSourceReadBinding(inputWith(binding))).toBeUndefined();
  });

  it("returns undefined when a PRESENT paginationRef is unconfirmed (not single-page)", () => {
    const binding = offsetBinding();
    binding.paginationRef = unconfirmedParameter("listCustomers", "offset"); // present, unconfirmed
    expect(resolveSourceReadBinding(inputWith(binding))).toBeUndefined();
  });

  it("returns undefined for a delta rule whose deltaCursorRef is unconfirmed", () => {
    const binding = deltaBinding();
    binding.deltaCursorRef = unconfirmedParameter("listOrderChanges", "since"); // present, unconfirmed
    expect(
      resolveSourceReadBinding({
        ...SOURCE_INPUT_BASE,
        rule: rule(),
        sourceCapabilities: caps({ supportsDeltaQuery: true }),
        sourceGroup: deltaGroup(),
        sourceBinding: binding,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the collection read ref does not resolve to an operation", () => {
    const binding = offsetBinding();
    binding.collectionReadRef = confirm(unconfirmedOperation("noSuchOp"));
    expect(resolveSourceReadBinding(inputWith(binding))).toBeUndefined();
  });

  it("treats an ABSENT paginationRef as a confirmed single-page read (not unresolved)", () => {
    const binding = offsetBinding();
    delete binding.paginationRef;
    const result = resolveSourceReadBinding(inputWith(binding));
    expect(result?.pagination).toEqual({ kind: "single-page" });
  });
});

// ── 5. Write-operation binding (create / update / delete) ───────────────────────

function targetGroup(): IrResourceGroup {
  return {
    resourceRef: "issues",
    name: "issues",
    operations: [
      {
        operationId: "createIssue",
        method: "post",
        path: "/issues",
        parameters: [],
        requestSchema: { name: "Issue", fields: [field("title", "string")] },
      },
      {
        operationId: "updateIssue",
        method: "patch",
        path: "/issues/{issueId}",
        parameters: [param("issueId", "path")],
      },
      {
        operationId: "deleteIssue",
        method: "delete",
        path: "/issues/{issueId}",
        parameters: [param("issueId", "path")],
      },
      {
        operationId: "closeIssueByQuery",
        method: "post",
        path: "/issues/close",
        parameters: [param("id", "query"), param("Idempotency-Key", "header")],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

function operationMapping(overrides: Partial<OperationMapping>): OperationMapping {
  return {
    id: "op-1",
    mappingId: "mapping-1",
    sourceOperationRef: "tasks/get /tasks",
    targetOperationRef: "issues/createIssue",
    action: "create",
    ...overrides,
  };
}

describe("resolveWriteOperationBinding — create / update / delete", () => {
  const group = targetGroup();

  it("resolves a create operation (no targetIdParamRef)", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/createIssue" }),
      group,
    );
    expect(binding?.method).toBe("POST");
    expect(binding?.pathTemplate).toBe("/issues");
  });

  it("resolves an update operation's targetIdParamRef to a path ParameterLocation", () => {
    const idRef = "issues/updateIssue#issueId";
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "issues/updateIssue",
        targetIdParamRef: idRef,
      }),
      group,
    );
    expect(binding?.method).toBe("PATCH");
    expect(binding?.pathTemplate).toBe("/issues/{issueId}");
    // The executor looks the id parameter up by the exact `targetIdParamRef` key.
    expect(binding?.parameterLocations[idRef]).toEqual({ name: "issueId", in: "path" });
  });

  it("resolves a delete operation's targetIdParamRef", () => {
    const idRef = "issues/deleteIssue#issueId";
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "delete",
        targetOperationRef: "issues/deleteIssue",
        targetIdParamRef: idRef,
      }),
      group,
    );
    expect(binding?.method).toBe("DELETE");
    expect(binding?.parameterLocations[idRef]).toEqual({ name: "issueId", in: "path" });
  });

  it("resolves a query-located id parameter and the target's idempotency-key header", () => {
    const idRef = "issues/closeIssueByQuery#id";
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "issues/closeIssueByQuery",
        targetIdParamRef: idRef,
      }),
      group,
    );
    expect(binding?.parameterLocations[idRef]).toEqual({ name: "id", in: "query" });
    expect(binding?.idempotencyKeyHeader).toBe("Idempotency-Key");
  });

  it("returns undefined for a targetOperationRef that does not resolve in the group", () => {
    expect(
      resolveWriteOperationBinding(
        operationMapping({ action: "update", targetOperationRef: "issues/ghostOp" }),
        group,
      ),
    ).toBeUndefined();
  });

  it("resolves the scenario Vikunja synthetic-operationId update (id path param)", async () => {
    const specPath = fileURLToPath(
      new URL(
        "../../../scenarios/scenario-1-small-overlap/specs/oas3/vikunja.trimmed.oas3.json",
        import.meta.url,
      ),
    );
    const ir = await buildIr(readFileSync(specPath, "utf8"));
    const tasks = ir.find((g) => g.resourceRef === "tasks") as IrResourceGroup;
    const idRef = "tasks/post /tasks/{id}#id"; // Vikunja uses POST for update (ground truth)
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "tasks/post /tasks/{id}",
        targetIdParamRef: idRef,
      }),
      tasks,
    );
    expect(binding?.method).toBe("POST");
    expect(binding?.pathTemplate).toBe("/tasks/{id}");
    expect(binding?.parameterLocations[idRef]).toEqual({ name: "id", in: "path" });
  });
});

// ── 6. Single-record target reader: stored-representation round-trip ─────────────

const APPLY_CREDENTIAL: CredentialApplier = (headers) => ({
  ...headers,
  authorization: "Bearer test-token",
});

class FakeProtocolClient implements ProtocolClient {
  public readonly requests: OutboundRequest[] = [];
  readonly #responder: (request: OutboundRequest) => OutboundResponse;
  public constructor(responder: (request: OutboundRequest) => OutboundResponse) {
    this.#responder = responder;
  }
  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    return Promise.resolve(this.#responder(request));
  }
}

class FakeCredentialAccess implements CredentialAccess {
  public async withCredential<T>(
    appId: string,
    fn: (credential: DecryptedCredential) => Promise<T>,
  ): Promise<WithCredentialResult<T>> {
    const secret: UsableCredentialSecret = { type: "apiKey", apiKey: "k" };
    const value = await fn({ credentialId: `c-${appId}`, type: "apiKey", scopes: [], secret });
    return { outcome: "invoked", value };
  }
}

class FixedSingleReadResolver implements SingleRecordReadResolver {
  public constructor(private readonly resolved: ResolvedSingleRecordRead | undefined) {}
  public resolve(): Promise<ResolvedSingleRecordRead | undefined> {
    return Promise.resolve(this.resolved);
  }
}

const TASK_READ: ResolvedSingleRecordRead = {
  baseUrl: "https://vikunja.test",
  method: "GET",
  pathTemplate: "/tasks/{id}",
  idLocation: { name: "id", in: "path" },
};

const READ_REQUEST = {
  targetAppId: "app-tgt",
  nativeId: "42",
  binding: { readOperationId: "get /tasks/{id}", idParamRef: "id" },
} as const;

function targetReader(
  protocol: ProtocolClient,
  resolved: ResolvedSingleRecordRead | undefined = TASK_READ,
): RestSingleRecordTargetReader {
  return new RestSingleRecordTargetReader(
    new FixedSingleReadResolver(resolved),
    protocol,
    new FakeCredentialAccess(),
    new AppLoadGovernor(),
    { applyCredential: APPLY_CREDENTIAL },
  );
}

describe("RestSingleRecordTargetReader — CF-5/CF-6 single-record read", () => {
  it("returns the target's stored representation verbatim (hashFieldValue matches the baseline)", async () => {
    // The baseline the write path captured from the target's stored representation.
    const stored: JsonRecord = { id: 42, title: "Ship it", done: false };
    const baselineHash = hashFieldValue(pathValue(stored, "title"));

    const protocol = new FakeProtocolClient((request) => {
      expect(request.url).toBe("https://vikunja.test/tasks/42");
      expect(request.method).toBe("GET");
      return { status: 200, headers: {}, body: stored };
    });
    const result = await targetReader(protocol).readRecord(READ_REQUEST);

    expect(result.found).toBe(true);
    if (!result.found) {
      throw new Error("expected found");
    }
    // CF reads the mapped field via readPath and hashes it — it must equal the baseline.
    expect(hashFieldValue(pathValue(result.record, "title"))).toBe(baselineHash);
    expect(result.record).toEqual(stored);
    expect(protocol.requests).toHaveLength(1); // OC-3: one read.
  });

  it("maps a 404 to a distinguished not-found (never a fabricated record)", async () => {
    const protocol = new FakeProtocolClient(() => ({ status: 404, headers: {}, body: undefined }));
    const result = await targetReader(protocol).readRecord(READ_REQUEST);
    expect(result.found).toBe(false);
  });

  it("throws on a 5xx rather than misreading a failed read as not-found", async () => {
    const protocol = new FakeProtocolClient(() => ({ status: 503, headers: {}, body: undefined }));
    await expect(targetReader(protocol).readRecord(READ_REQUEST)).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the read binding does not resolve (a config error, not not-found)", async () => {
    const protocol = new FakeProtocolClient(() => ({ status: 200, headers: {}, body: {} }));
    const reader = new RestSingleRecordTargetReader(
      new FixedSingleReadResolver(undefined),
      protocol,
      new FakeCredentialAccess(),
      new AppLoadGovernor(),
      { applyCredential: APPLY_CREDENTIAL },
    );
    await expect(reader.readRecord(READ_REQUEST)).rejects.toThrow(/did not resolve/);
  });

  it("throws on an unfilled path template rather than sending it and fabricating a not-found", async () => {
    // A single-record read whose op has path params beyond the record id (Gitea's
    // `{owner}/{repo}`) — filling only `{index}` leaves `{owner}`/`{repo}` unfilled.
    const constantParamRead: ResolvedSingleRecordRead = {
      baseUrl: "https://gitea.test",
      method: "GET",
      pathTemplate: "/repos/{owner}/{repo}/issues/{index}",
      idLocation: { name: "index", in: "path" },
    };
    const protocol = new FakeProtocolClient(() => ({ status: 404, headers: {}, body: undefined }));
    await expect(
      targetReader(protocol, constantParamRead).readRecord(READ_REQUEST),
    ).rejects.toThrow(/unfilled parameter/);
    // It must NOT have sent a request with a literal `{owner}` in the URL.
    expect(protocol.requests).toHaveLength(0);
  });

  it("fills a query-located id parameter", async () => {
    const queryRead: ResolvedSingleRecordRead = {
      baseUrl: "https://vikunja.test/",
      method: "GET",
      pathTemplate: "/task",
      idLocation: { name: "taskId", in: "query" },
    };
    const protocol = new FakeProtocolClient((request) => {
      expect(request.url).toBe("https://vikunja.test/task?taskId=42");
      return { status: 200, headers: {}, body: { id: 42 } };
    });
    const result = await targetReader(protocol, queryRead).readRecord(READ_REQUEST);
    expect(result.found).toBe(true);
  });
});

// ── 7. RepoRestSourceBindingResolver — end-to-end over fake repos ───────────────

class FakeRepos implements BindingResolverRepositories {
  public constructor(
    private readonly rules: Map<string, SyncRule>,
    private readonly mappings: Map<string, ApprovedMapping>,
    private readonly specs: Map<string, ApiSpec>,
    private readonly bindings: Map<string, ResourceBinding[]>,
    private readonly apps: Map<string, RegisteredApp>,
  ) {}
  public syncRules: SyncRuleReader = { getById: (id) => Promise.resolve(this.rules.get(id)) };
  public approvedMappings: ApprovedMappingReader = {
    getById: (id) => Promise.resolve(this.mappings.get(id)),
  };
  public apiSpecs: ApiSpecReader = {
    getById: (id) => Promise.resolve(this.specs.get(id)),
    listByAppId: (appId) =>
      Promise.resolve([...this.specs.values()].filter((s) => s.appId === appId)),
  };
  public resourceBindings: ResourceBindingReader = {
    listByApiSpecId: (id) => Promise.resolve(this.bindings.get(id) ?? []),
  };
  public registeredApps: RegisteredAppReader = {
    getById: (id) => Promise.resolve(this.apps.get(id)),
  };
}

function apiSpec(
  overrides: Partial<ApiSpec> & Pick<ApiSpec, "id" | "appId" | "parsedIR">,
): ApiSpec {
  return {
    role: "PROVIDER",
    rawDocument: {},
    analysisExclusions: [],
    version: 1,
    contentHash: "hash",
    status: "active",
    createdAt: CONFIRMED_AT,
    ...overrides,
  };
}

function app(id: string, overrides: Partial<RegisteredApp> = {}): RegisteredApp {
  return {
    id,
    name: id,
    status: "active",
    baseUrl: `https://${id}.test`,
    capabilities: caps(),
    createdAt: CONFIRMED_AT,
    ...overrides,
  };
}

describe("RepoRestSourceBindingResolver — loads state and composes the binding by ruleId", () => {
  it("resolves a full-fetch source-read binding end to end", async () => {
    const sourceBinding = offsetBinding();
    const specs = new Map<string, ApiSpec>([
      ["spec-src", apiSpec({ id: "spec-src", appId: "app-src", parsedIR: [offsetGroup()] })],
    ]);
    const repos = new FakeRepos(
      new Map([["r1", rule({ id: "r1", resourcePairRef: "app-src:customers|app-tgt:issues" })]]),
      new Map([
        [
          "mapping-1",
          {
            id: "mapping-1",
            sourceSpecId: "spec-src",
            targetSpecId: "spec-tgt",
            sourceAppId: "app-src",
            targetAppId: "app-tgt",
            variant: "peer-peer",
            approvedBy: "op",
            approvedAt: CONFIRMED_AT,
            status: "active",
          },
        ],
      ]),
      specs,
      new Map([["spec-src", [sourceBinding]]]),
      new Map([["app-src", app("app-src")]]),
    );

    const resolver = new RepoRestSourceBindingResolver(repos);
    const result = await resolver.resolve("r1");
    expect(result?.sourceAppId).toBe("app-src");
    expect(result?.baseUrl).toBe("https://app-src.test");
    expect(result?.path).toBe("/customers");
    expect(result?.pagination).toEqual({
      kind: "offset",
      offsetParam: "offset",
      limitParam: "limit",
      pageSize: 100,
    });
  });

  it("returns undefined for an unknown rule (never fabricated)", async () => {
    const repos = new FakeRepos(new Map(), new Map(), new Map(), new Map(), new Map());
    expect(await new RepoRestSourceBindingResolver(repos).resolve("missing")).toBeUndefined();
  });
});

// Keep the OperationMappingReader port referenced (documents the composition-root port
// set even though the source-read resolver does not itself read operation mappings).
const _operationMappingPort: OperationMappingReader = {
  listOperationMappings: () => Promise.resolve([]),
};
void _operationMappingPort;
