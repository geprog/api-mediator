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
  ScopePathBinding,
  ScopeTransform,
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
  RepoSingleRecordReadResolver,
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
import { fillScopePathParameters, findUnfilledPathParam } from "./path-template.js";
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

/** A `constant` scope path-parameter binding (SS-1 shape), confirmed by default. */
function scopeConstant(parameterName: string, value: string, confirmed = true): ScopePathBinding {
  return {
    kind: "constant",
    parameterName,
    value,
    confirmedBy: confirmed ? "operator" : null,
    confirmedAt: confirmed ? CONFIRMED_AT : null,
  };
}

/** A `record-derived` scope path-parameter binding (SS-8 shape), confirmed by default. */
function scopeRecordDerived(
  parameterName: string,
  sourceScopeKey: string,
  opts: { transform?: ScopeTransform; confirmed?: boolean } = {},
): ScopePathBinding {
  const confirmed = opts.confirmed ?? true;
  return {
    kind: "record-derived",
    parameterName,
    sourceScopeKey,
    ...(opts.transform !== undefined ? { transform: opts.transform } : {}),
    confirmedBy: confirmed ? "operator" : null,
    confirmedAt: confirmed ? CONFIRMED_AT : null,
  };
}

/** A minimal `ResourceBinding` carrying only `scopePathBindings` (SS-4 fill input). */
function scopedBinding(
  resourceRef: string,
  scopePathBindings: ScopePathBinding[] = [],
): ResourceBinding {
  return {
    id: `rb-${resourceRef}`,
    apiSpecId: `spec-${resourceRef}`,
    resourceRef,
    scopePathBindings,
  };
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
  // The scenario-5 `issues` fixture has no scope path parameters, so an empty scope binding.
  const noScope = scopedBinding("issues");

  it("resolves a create operation (no targetIdParamRef)", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/createIssue" }),
      group,
      noScope,
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
      noScope,
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
      noScope,
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
      noScope,
    );
    expect(binding?.parameterLocations[idRef]).toEqual({ name: "id", in: "query" });
    expect(binding?.idempotencyKeyHeader).toBe("Idempotency-Key");
  });

  it("returns undefined for a targetOperationRef that does not resolve in the group", () => {
    expect(
      resolveWriteOperationBinding(
        operationMapping({ action: "update", targetOperationRef: "issues/ghostOp" }),
        group,
        noScope,
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
      scopedBinding("tasks"),
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

// ── 8. SS-4: scope-constant substitution + the backstop ─────────────────────────

/**
 * A hand-built Gitea `issues` IR group mirroring the real trimmed scenario-1 spec:
 * a repo-scoped collection read `GET /repos/{owner}/{repo}/issues`, a create
 * `POST /repos/{owner}/{repo}/issues`, and update/delete/by-id-read on
 * `/repos/{owner}/{repo}/issues/{index}` — `{owner}`/`{repo}` are scope, `{index}` is the
 * record id.
 */
function giteaIssuesGroup(): IrResourceGroup {
  const repoScope = [param("owner", "path"), param("repo", "path")];
  return {
    resourceRef: "issues",
    name: "issues",
    operations: [
      {
        operationId: "issueListIssues",
        method: "get",
        path: "/repos/{owner}/{repo}/issues",
        parameters: [...repoScope, param("page", "query"), param("limit", "query")],
        responseSchema: {
          name: "Issue",
          fields: [field("number", "integer"), field("title", "string")],
        },
      },
      {
        operationId: "issueCreateIssue",
        method: "post",
        path: "/repos/{owner}/{repo}/issues",
        parameters: repoScope,
        requestSchema: { name: "CreateIssue", fields: [field("title", "string")] },
      },
      {
        operationId: "issueEditIssue",
        method: "patch",
        path: "/repos/{owner}/{repo}/issues/{index}",
        parameters: [...repoScope, param("index", "path")],
      },
      {
        operationId: "issueDelete",
        method: "delete",
        path: "/repos/{owner}/{repo}/issues/{index}",
        parameters: [...repoScope, param("index", "path")],
      },
      {
        operationId: "issueGetIssue",
        method: "get",
        path: "/repos/{owner}/{repo}/issues/{index}",
        parameters: [...repoScope, param("index", "path")],
        responseSchema: {
          name: "Issue",
          fields: [field("number", "integer"), field("title", "string")],
        },
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

/** The Gitea `issues` `ResourceBinding`: confirmed native id + collection read + the given scope constants. */
function giteaIssuesBinding(scope: ScopePathBinding[]): ResourceBinding {
  return {
    id: "rb-gitea-issues",
    apiSpecId: "spec-gitea",
    resourceRef: "issues",
    nativeIdRef: confirm(unconfirmedField("number")),
    collectionReadRef: confirm(unconfirmedOperation("issueListIssues")),
    scopePathBindings: scope,
  };
}

const GITEA_SCOPE = [scopeConstant("owner", "alice"), scopeConstant("repo", "phoenix")];

describe("fillScopePathParameters / findUnfilledPathParam (SS-4 unit)", () => {
  it("fills every scope param, leaving the named record-id templated", () => {
    expect(
      fillScopePathParameters("/repos/{owner}/{repo}/issues/{index}", GITEA_SCOPE, "index"),
    ).toBe("/repos/alice/phoenix/issues/{index}");
  });

  it("fills ALL path params when there is no record-id param (collection read)", () => {
    expect(fillScopePathParameters("/repos/{owner}/{repo}/issues", GITEA_SCOPE, undefined)).toBe(
      "/repos/alice/phoenix/issues",
    );
  });

  it("returns undefined when a scope param has no confirmed constant (never fabricates)", () => {
    expect(
      fillScopePathParameters(
        "/repos/{owner}/{repo}/issues",
        [scopeConstant("owner", "alice")],
        undefined,
      ),
    ).toBeUndefined();
    // Present-but-unconfirmed is also unresolved.
    expect(
      fillScopePathParameters(
        "/repos/{owner}/{repo}/issues",
        [scopeConstant("owner", "alice"), scopeConstant("repo", "phoenix", false)],
        undefined,
      ),
    ).toBeUndefined();
  });

  it("url-encodes a substituted scope value", () => {
    expect(
      fillScopePathParameters("/t/{tenant}/x", [scopeConstant("tenant", "a b/c")], undefined),
    ).toBe("/t/a%20b%2Fc/x");
  });

  it("detects the first still-templated param (backstop)", () => {
    expect(findUnfilledPathParam("/repos/alice/phoenix/issues/{index}")).toBe("{index}");
    expect(findUnfilledPathParam("/repos/alice/phoenix/issues")).toBeUndefined();
  });
});

describe("SS-4.1 source poll — scope constants fill the collection-read path", () => {
  it("resolves Gitea /repos/{owner}/{repo}/issues → /repos/alice/phoenix/issues (no {…} left)", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps(),
      sourceGroup: giteaIssuesGroup(),
      sourceBinding: giteaIssuesBinding(GITEA_SCOPE),
    });
    expect(result?.path).toBe("/repos/alice/phoenix/issues");
    expect(result?.path).not.toContain("{");
  });
});

describe("SS-4.2 write — non-id scope filled, targetIdParamRef stays templated", () => {
  it("Gitea update PATCH /repos/{owner}/{repo}/issues/{index}: owner/repo filled, {index} templated", () => {
    const idRef = "issues/issueEditIssue#index";
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "issues/issueEditIssue",
        targetIdParamRef: idRef,
      }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_SCOPE),
    );
    expect(binding?.method).toBe("PATCH");
    expect(binding?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
    expect(binding?.parameterLocations[idRef]).toEqual({ name: "index", in: "path" });
  });

  it("Gitea delete: owner/repo filled, {index} templated", () => {
    const idRef = "issues/issueDelete#index";
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "delete",
        targetOperationRef: "issues/issueDelete",
        targetIdParamRef: idRef,
      }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_SCOPE),
    );
    expect(binding?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
  });
});

describe("SS-4.2 the Vikunja {id} collision — role, not bare name, decides", () => {
  // One `tasks` resource, one scope constant `id = 42` (the project id), two ops sharing
  // the bare path-param name `{id}` with OPPOSITE roles.
  function vikunjaTasksGroup(): IrResourceGroup {
    return {
      resourceRef: "tasks",
      name: "tasks",
      operations: [
        {
          operationId: "put /projects/{id}/tasks",
          method: "put",
          path: "/projects/{id}/tasks",
          parameters: [param("id", "path")],
          requestSchema: { name: "Task", fields: [field("title", "string")] },
        },
        {
          operationId: "post /tasks/{id}",
          method: "post",
          path: "/tasks/{id}",
          parameters: [param("id", "path")],
        },
      ],
      schemas: [],
      crossResourceRefs: [],
    };
  }
  const tasksBinding = scopedBinding("tasks", [scopeConstant("id", "42")]);

  it("create PUT /projects/{id}/tasks: {id} is a SCOPE param → filled from the project constant (42)", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "tasks/put /projects/{id}/tasks" }),
      vikunjaTasksGroup(),
      tasksBinding,
    );
    expect(binding?.method).toBe("PUT");
    expect(binding?.pathTemplate).toBe("/projects/42/tasks");
  });

  it("update POST /tasks/{id}: {id} is the RECORD ID → stays templated, NEVER filled from the project constant", () => {
    const idRef = "tasks/post /tasks/{id}#id";
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "tasks/post /tasks/{id}",
        targetIdParamRef: idRef,
      }),
      vikunjaTasksGroup(),
      tasksBinding,
    );
    expect(binding?.pathTemplate).toBe("/tasks/{id}");
    expect(binding?.parameterLocations[idRef]).toEqual({ name: "id", in: "path" });
  });
});

describe("SS-4.3 single-record read — scope filled, id parameter templated", () => {
  it("resolveSingleRecordReadBinding + resolveSingleRecordRead fill owner/repo, leave {index}", () => {
    const binding = giteaIssuesBinding(GITEA_SCOPE);
    const readBinding = resolveSingleRecordReadBinding(giteaIssuesGroup(), binding);
    expect(readBinding).toEqual({ readOperationId: "issueGetIssue", idParamRef: "index" });
    const resolved = resolveSingleRecordRead({
      binding: readBinding as CfReadBinding,
      targetGroup: giteaIssuesGroup(),
      baseUrl: "https://gitea.test",
      targetBinding: binding,
    });
    expect(resolved?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
    expect(resolved?.idLocation).toEqual({ name: "index", in: "path" });
  });

  it("RepoSingleRecordReadResolver loads the resource binding and fills scope end to end", async () => {
    const specs = new Map<string, ApiSpec>([
      ["spec-gitea", apiSpec({ id: "spec-gitea", appId: "gitea", parsedIR: [giteaIssuesGroup()] })],
    ]);
    const repos = new FakeRepos(
      new Map(),
      new Map(),
      specs,
      new Map([["spec-gitea", [giteaIssuesBinding(GITEA_SCOPE)]]]),
      new Map([["gitea", app("gitea")]]),
    );
    const resolver = new RepoSingleRecordReadResolver(
      repos.apiSpecs,
      repos.registeredApps,
      repos.resourceBindings,
    );
    const resolved = await resolver.resolve("gitea", {
      readOperationId: "issueGetIssue",
      idParamRef: "index",
    });
    expect(resolved?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
    expect(resolved?.baseUrl).toBe("https://gitea.test");
  });
});

describe("SS-4.4 an unconfirmed / missing scope constant unresolves the whole binding", () => {
  it("source read: a missing owner constant → undefined (never a fabricated URL)", () => {
    const result = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps(),
      sourceGroup: giteaIssuesGroup(),
      sourceBinding: giteaIssuesBinding([scopeConstant("repo", "phoenix")]),
    });
    expect(result).toBeUndefined();
  });

  it("write: an UNCONFIRMED owner constant → undefined", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "issues/issueEditIssue",
        targetIdParamRef: "issues/issueEditIssue#index",
      }),
      giteaIssuesGroup(),
      giteaIssuesBinding([
        scopeConstant("owner", "alice", false),
        scopeConstant("repo", "phoenix"),
      ]),
    );
    expect(binding).toBeUndefined();
  });

  it("single-record read: a missing repo constant → undefined", () => {
    const resolved = resolveSingleRecordRead({
      binding: { readOperationId: "issueGetIssue", idParamRef: "index" },
      targetGroup: giteaIssuesGroup(),
      baseUrl: "https://gitea.test",
      targetBinding: giteaIssuesBinding([scopeConstant("owner", "alice")]),
    });
    expect(resolved).toBeUndefined();
  });
});

describe("SS-4.6 scenario-1 Gitea source + target resolve end to end", () => {
  it("source poll → /repos/alice/phoenix/issues; update → /repos/alice/phoenix/issues/{index}", () => {
    const binding = giteaIssuesBinding(GITEA_SCOPE);
    const source = resolveSourceReadBinding({
      ...SOURCE_INPUT_BASE,
      rule: rule(),
      sourceCapabilities: caps(),
      sourceGroup: giteaIssuesGroup(),
      sourceBinding: binding,
    });
    const idRef = "issues/issueEditIssue#index";
    const update = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "issues/issueEditIssue",
        targetIdParamRef: idRef,
      }),
      giteaIssuesGroup(),
      binding,
    );
    expect(source?.path).toBe("/repos/alice/phoenix/issues");
    expect(update?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
    // The record id is filled per record downstream from the RecordLink, not here.
    expect(update?.parameterLocations[idRef]).toEqual({ name: "index", in: "path" });
  });
});

// ── 9. SS-8b: record-derived scope fill from the change's captured scope ─────────

/**
 * The Gitea `issues` resource re-used as a `record-derived` **target**: `{owner}`/`{repo}`
 * are filled from the record's captured scope (SS-8.3). The captured scope keys the source
 * `sourceScopeRef` produced (`owner` + `name`, from a Gitea issue's `repository.owner`/
 * `repository.name`) are selected per-parameter by each binding's `sourceScopeKey` — here
 * `owner → {owner}` and `name → {repo}`.
 */
const GITEA_RECORD_DERIVED = [
  scopeRecordDerived("owner", "owner"),
  scopeRecordDerived("repo", "name"),
];
const CAPTURED = { owner: "alice", name: "phoenix" };

describe("SS-8.3 write — record-derived scope filled from the captured scope", () => {
  it("create POST /repos/{owner}/{repo}/issues → /repos/alice/phoenix/issues (filled from captured scope)", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_RECORD_DERIVED),
      CAPTURED,
    );
    expect(binding?.method).toBe("POST");
    expect(binding?.pathTemplate).toBe("/repos/alice/phoenix/issues");
    expect(binding?.pathTemplate).not.toContain("{");
  });

  it("update: record-derived owner/repo filled, the record-id {index} stays templated (SS-4 discipline)", () => {
    const idRef = "issues/issueEditIssue#index";
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "issues/issueEditIssue",
        targetIdParamRef: idRef,
      }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_RECORD_DERIVED),
      CAPTURED,
    );
    expect(binding?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
    expect(binding?.parameterLocations[idRef]).toEqual({ name: "index", in: "path" });
  });

  it("the value passes through a rename transform unchanged (value-preserving)", () => {
    const rename: ScopeTransform = { kind: "rename" };
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding([
        scopeRecordDerived("owner", "owner", { transform: rename }),
        scopeRecordDerived("repo", "name", { transform: rename }),
      ]),
      CAPTURED,
    );
    expect(binding?.pathTemplate).toBe("/repos/alice/phoenix/issues");
  });

  it("a captured scope keyed differently from the target param is selected by sourceScopeKey", () => {
    // sourceScopeKey `name` fills target param `repo` — the key selects the component.
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding([
        scopeRecordDerived("owner", "owner"),
        scopeRecordDerived("repo", "name"),
      ]),
      { owner: "octo", name: "hub" },
    );
    expect(binding?.pathTemplate).toBe("/repos/octo/hub/issues");
  });

  it("a numeric captured value is stringified into the path (shared value-space)", () => {
    const group: IrResourceGroup = {
      resourceRef: "tasks",
      name: "tasks",
      operations: [
        {
          operationId: "createTask",
          method: "put",
          path: "/projects/{id}/tasks",
          parameters: [param("id", "path")],
          requestSchema: { name: "Task", fields: [field("title", "string")] },
        },
      ],
      schemas: [],
      crossResourceRefs: [],
    };
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "tasks/createTask" }),
      group,
      scopedBinding("tasks", [scopeRecordDerived("id", "project")]),
      { project: 42 },
    );
    expect(binding?.pathTemplate).toBe("/projects/42/tasks");
  });
});

describe("SS-8.3 fail-loud — a missing / unconfirmed / uncaptured record-derived scope refuses the write", () => {
  it("a missing captured component → undefined (never a fabricated scope)", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_RECORD_DERIVED),
      { owner: "alice" }, // `name` was not carried by the source record
    );
    expect(binding).toBeUndefined();
  });

  it("an UNCONFIRMED record-derived binding → undefined (used nowhere until confirmed)", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding([
        scopeRecordDerived("owner", "owner"),
        scopeRecordDerived("repo", "name", { confirmed: false }),
      ]),
      CAPTURED,
    );
    expect(binding).toBeUndefined();
  });

  it("no captured scope at all (e.g. a delete) but record-derived bindings → undefined", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "delete",
        targetOperationRef: "issues/issueDelete",
        targetIdParamRef: "issues/issueDelete#index",
      }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_RECORD_DERIVED),
      // capturedScope omitted — a delete carries none.
    );
    expect(binding).toBeUndefined();
  });

  it("a captured value that is JSON null is not a usable scope segment → undefined", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_RECORD_DERIVED),
      { owner: "alice", name: null },
    );
    expect(binding).toBeUndefined();
  });

  it("the record-id param is NEVER filled from the captured scope (record-id-vs-scope discipline)", () => {
    // A defensive record-derived entry named for the record-id param + a captured `index`
    // component must NOT fill `{index}` — it stays templated for the RecordLink fill.
    const idRef = "issues/issueEditIssue#index";
    const binding = resolveWriteOperationBinding(
      operationMapping({
        action: "update",
        targetOperationRef: "issues/issueEditIssue",
        targetIdParamRef: idRef,
      }),
      giteaIssuesGroup(),
      giteaIssuesBinding([
        scopeRecordDerived("owner", "owner"),
        scopeRecordDerived("repo", "name"),
        scopeRecordDerived("index", "index"),
      ]),
      { owner: "alice", name: "phoenix", index: 999 },
    );
    expect(binding?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
  });
});

describe("SS-8.3 no-regression + single-record read", () => {
  it("a constant scope param still fills when a captured scope is supplied (mixed constant + record-derived)", () => {
    const binding = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding([scopeConstant("owner", "alice"), scopeRecordDerived("repo", "name")]),
      { name: "phoenix" },
    );
    expect(binding?.pathTemplate).toBe("/repos/alice/phoenix/issues");
  });

  it("a constant-only binding is unchanged whether or not a captured scope is supplied (SS-4 no regression)", () => {
    const withScope = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_SCOPE),
      CAPTURED,
    );
    const withoutScope = resolveWriteOperationBinding(
      operationMapping({ action: "create", targetOperationRef: "issues/issueCreateIssue" }),
      giteaIssuesGroup(),
      giteaIssuesBinding(GITEA_SCOPE),
    );
    expect(withScope?.pathTemplate).toBe("/repos/alice/phoenix/issues");
    expect(withoutScope?.pathTemplate).toBe("/repos/alice/phoenix/issues");
  });

  it("single-record read fills record-derived scope, leaves the record-id {index} templated", () => {
    const readBinding: CfReadBinding = { readOperationId: "issueGetIssue", idParamRef: "index" };
    const resolved = resolveSingleRecordRead({
      binding: readBinding,
      targetGroup: giteaIssuesGroup(),
      baseUrl: "https://gitea.test",
      targetBinding: giteaIssuesBinding(GITEA_RECORD_DERIVED),
      capturedScope: CAPTURED,
    });
    expect(resolved?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
    expect(resolved?.idLocation).toEqual({ name: "index", in: "path" });
  });

  it("single-record read with a missing captured component → undefined (fail loud)", () => {
    const readBinding: CfReadBinding = { readOperationId: "issueGetIssue", idParamRef: "index" };
    const resolved = resolveSingleRecordRead({
      binding: readBinding,
      targetGroup: giteaIssuesGroup(),
      baseUrl: "https://gitea.test",
      targetBinding: giteaIssuesBinding(GITEA_RECORD_DERIVED),
      capturedScope: { owner: "alice" },
    });
    expect(resolved).toBeUndefined();
  });
});

// Keep the OperationMappingReader port referenced (documents the composition-root port
// set even though the source-read resolver does not itself read operation mappings).
const _operationMappingPort: OperationMappingReader = {
  listOperationMappings: () => Promise.resolve([]),
};
void _operationMappingPort;
