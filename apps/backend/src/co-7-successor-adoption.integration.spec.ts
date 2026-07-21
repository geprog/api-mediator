import { randomUUID } from "node:crypto";

import {
  AdapterCompositionRepository,
  ApiSpecRepository,
  ApprovedMappingRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  createDb,
  graphEdge,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  toAdapterBindingInsert,
  toAdapterEndpointInsert,
  tx,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  ApprovedMapping,
  ApprovedMappingStatus,
  ChainInput,
  FieldMapping,
  Ir,
  IrParameter,
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
} from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AdapterCompositionService,
  type EndpointCacheInvalidator,
} from "./modules/adapter-composition/index.js";

/**
 * Live-Postgres integration test for Phase-5 **CO-7 — successor adoption** through the
 * **real** {@link AdapterCompositionService.adoptSuccessor}, the **real** context loader,
 * validator, and re-point/flag repositories, over a live Postgres. Excluded from
 * `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable; the only external dependency is the database.
 *
 * It drives a **simulated** succession (no Phase-6 trigger): predecessor + successor
 * `ApprovedMapping`s are seeded directly, and `adoptSuccessor` is called with their ids.
 * It proves the CO-7 crux end to end:
 *  - **CO-7.1/7.2 (carry-over):** a compatible successor re-points the bindings **in place**
 *    — same binding ids, `role`/`executionOrder`/`dependsOnBindingId`/`chainInputs`
 *    preserved, no `proposed` attach — and the endpoint stays `active`;
 *  - **CO-7.3/7.4 (re-validation flags broken):** a successor that drops a dependent's
 *    upstream response field, or drops a required parameter's mapping, flags the endpoint
 *    `composition-required` (never a broken `active`) while the bindings stay re-pointed and
 *    active (not decomposed);
 *  - **CO-7.5 (cache drop):** every affected endpoint is invalidated through the
 *    {@link EndpointCacheInvalidator} seam (asserted with a spy);
 *  - **idempotency / no-op:** re-adopting, or adopting a mapping with no bindings, is a clean
 *    no-op — no status flip, no cache drop, no audit row.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-21T00:00:00.000Z");
const ACTOR = `operator:co7-${randomUUID()}`;

// One consumer app + spec; one backend app + spec per endpoint (each mapping is
// consumer→one-backend). Ids are generated so reruns never collide.
const CONSUMER_APP = randomUUID();
const CONSUMER_SPEC = randomUUID();

const BACKEND_CHAIN_APP = randomUUID();
const BACKEND_CHAIN_SPEC = randomUUID();
const BACKEND_BC_APP = randomUUID();
const BACKEND_BC_SPEC = randomUUID();
const BACKEND_PARAM_APP = randomUUID();
const BACKEND_PARAM_SPEC = randomUUID();

// Endpoint CHAIN — fanout-merge, primary + chained supplement, both on M_CHAIN.
const M_CHAIN = randomUUID();
const M_CHAIN_OK = randomUUID();
const ENDPOINT_CHAIN = randomUUID();
const CHAIN_PRIMARY = randomUUID();
const CHAIN_SUPPLEMENT = randomUUID();

// Endpoint BROKEN_CHAIN — fanout-merge, primary + chained supplement, both on M_BC.
const M_BC = randomUUID();
const M_BC_BROKEN = randomUUID();
const ENDPOINT_BC = randomUUID();
const BC_PRIMARY = randomUUID();
const BC_SUPPLEMENT = randomUUID();

// Endpoint BROKEN_PARAM — single, one binding on M_BP whose required backend param is
// covered by a ParameterMapping the successor drops.
const M_BP = randomUUID();
const M_BP_BROKEN = randomUUID();
const ENDPOINT_PARAM = randomUUID();
const PARAM_BINDING = randomUUID();

// A predecessor mapping that backs NO binding — the no-op adoption target.
const M_ORPHAN = randomUUID();

/** A spy {@link EndpointCacheInvalidator} recording every by-endpoint drop. */
class SpyEndpointInvalidator implements EndpointCacheInvalidator {
  public readonly calls: string[] = [];
  public invalidateEndpoint(endpointId: string): void {
    this.calls.push(endpointId);
  }
}

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: false,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: CREATED_AT,
  };
}

function specOf(id: string, appId: string, role: ApiSpec["role"], ir: Ir): ApiSpec {
  return {
    id,
    appId,
    role,
    rawDocument: { openapi: "3.1.0" },
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}

/** A one-operation resource group (read). `responseFields` build a response schema. */
function group(
  resourceRef: string,
  operationId: string,
  parameters: IrParameter[],
  responseFields: { name: string; required: boolean }[] = [],
): Ir[number] {
  return {
    resourceRef,
    name: resourceRef,
    operations: [
      {
        operationId,
        method: "get",
        path: `/${resourceRef}`,
        parameters,
        ...(responseFields.length > 0
          ? {
              responseSchema: {
                name: `${resourceRef}Response`,
                fields: responseFields.map((field) => ({
                  name: field.name,
                  type: "string",
                  required: field.required,
                })),
              },
            }
          : {}),
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

const consumerIr: Ir = [
  group(
    "dashA",
    "getDashA",
    [],
    [
      { name: "id", required: true },
      { name: "name", required: false },
    ],
  ),
  group(
    "dashB",
    "getDashB",
    [],
    [
      { name: "id", required: true },
      { name: "name", required: false },
    ],
  ),
  group(
    "item",
    "getItem",
    [{ name: "itemId", location: "query", required: false, type: "string" }],
    [{ name: "id", required: true }],
  ),
];

const backendChainIr: Ir = [
  group("alpha", "getAlpha", []),
  group("beta", "getBeta", [
    { name: "betaKey", location: "query", required: true, type: "string" },
  ]),
];
const backendBcIr: Ir = [
  group("alpha2", "getAlpha2", []),
  group("beta2", "getBeta2", [
    { name: "betaKey2", location: "query", required: true, type: "string" },
  ]),
];
const backendParamIr: Ir = [
  group("gamma", "getGamma", [
    { name: "gammaId", location: "query", required: true, type: "string" },
  ]),
];

function mappingOf(
  id: string,
  targetSpecId: string,
  targetAppId: string,
  status: ApprovedMappingStatus,
): ApprovedMapping {
  return {
    id,
    sourceSpecId: CONSUMER_SPEC,
    targetSpecId,
    sourceAppId: CONSUMER_APP,
    targetAppId,
    variant: "consumer-provider",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status,
  };
}

function opMapping(
  mappingId: string,
  sourceOperationRef: string,
  targetOperationRef: string,
): OperationMapping {
  return { id: randomUUID(), mappingId, sourceOperationRef, targetOperationRef, action: "read" };
}

function responseField(mappingId: string, sourcePath: string, targetPath: string): FieldMapping {
  return {
    id: randomUUID(),
    mappingId,
    sourcePath,
    targetPath,
    transform: "rename",
    phase: "response",
  };
}

function endpointOf(
  id: string,
  consumerOperationId: string,
  aggregationStrategy: AdapterEndpoint["aggregationStrategy"],
): AdapterEndpoint {
  return {
    id,
    consumerAppId: CONSUMER_APP,
    consumerOperationId,
    status: "active",
    aggregationStrategy,
    strictness: "degraded",
  };
}

function bindingOf(input: {
  id: string;
  endpointId: string;
  backendAppId: string;
  backendOperationId: string;
  approvedMappingId: string;
  role: AdapterBinding["role"];
  executionOrder?: number;
  dependsOnBindingId?: string;
  chainInputs?: ChainInput[];
}): AdapterBinding {
  return {
    id: input.id,
    adapterEndpointId: input.endpointId,
    backendAppId: input.backendAppId,
    backendOperationId: input.backendOperationId,
    approvedMappingId: input.approvedMappingId,
    role: input.role,
    status: "active",
    ...(input.executionOrder !== undefined ? { executionOrder: input.executionOrder } : {}),
    ...(input.dependsOnBindingId !== undefined
      ? { dependsOnBindingId: input.dependsOnBindingId }
      : {}),
    ...(input.chainInputs !== undefined ? { chainInputs: input.chainInputs } : {}),
  };
}

async function cleanup(db: Database): Promise<void> {
  await db.delete(auditLog);
  await db.delete(adapterBinding);
  await db.delete(adapterEndpoint);
  await db.delete(graphEdge);
  await db.delete(approvedMapping); // cascades operation/parameter/field mappings
  await db.delete(apiSpec);
  await db.delete(registeredApp);
}

suite("Phase-5 CO-7 successor adoption integration (requires Postgres)", () => {
  let db: Database;
  let service: AdapterCompositionService;
  let spy: SpyEndpointInvalidator;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await cleanup(db);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(CONSUMER_APP, "co7-consumer"));
      await apps.create(appOf(BACKEND_CHAIN_APP, "co7-backend-chain"));
      await apps.create(appOf(BACKEND_BC_APP, "co7-backend-bc"));
      await apps.create(appOf(BACKEND_PARAM_APP, "co7-backend-param"));

      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(CONSUMER_SPEC, CONSUMER_APP, "CONSUMER", consumerIr));
      await specs.create(specOf(BACKEND_CHAIN_SPEC, BACKEND_CHAIN_APP, "PROVIDER", backendChainIr));
      await specs.create(specOf(BACKEND_BC_SPEC, BACKEND_BC_APP, "PROVIDER", backendBcIr));
      await specs.create(specOf(BACKEND_PARAM_SPEC, BACKEND_PARAM_APP, "PROVIDER", backendParamIr));

      const mappings = new ApprovedMappingRepository(txn);
      const artifacts = new MappingArtifactsRepository(txn);

      // ── Endpoint CHAIN: predecessor + a COMPATIBLE successor ──────────────────
      // Both keep the primary's `dashA/id` response field the supplement's chainInput reads.
      for (const [mappingId, status] of [
        [M_CHAIN, "stale"],
        [M_CHAIN_OK, "active"],
      ] as const) {
        await mappings.insert(mappingOf(mappingId, BACKEND_CHAIN_SPEC, BACKEND_CHAIN_APP, status));
        await artifacts.replaceChildren(mappingId, {
          fieldMappings: [
            responseField(mappingId, "alpha/a_id", "dashA/id"),
            responseField(mappingId, "beta/b_name", "dashA/name"),
          ],
          operationMappings: [
            opMapping(mappingId, "dashA/getDashA", "alpha/getAlpha"),
            opMapping(mappingId, "dashA/getDashA", "beta/getBeta"),
          ],
          parameterMappings: [],
        });
      }

      // ── Endpoint BROKEN_CHAIN: predecessor keeps `dashB/id`; successor DROPS it ─
      await mappings.insert(mappingOf(M_BC, BACKEND_BC_SPEC, BACKEND_BC_APP, "stale"));
      await artifacts.replaceChildren(M_BC, {
        fieldMappings: [
          responseField(M_BC, "alpha2/a_id", "dashB/id"), // primary provides the chained field
          responseField(M_BC, "beta2/b_name", "dashB/name"),
        ],
        operationMappings: [
          opMapping(M_BC, "dashB/getDashB", "alpha2/getAlpha2"),
          opMapping(M_BC, "dashB/getDashB", "beta2/getBeta2"),
        ],
        parameterMappings: [],
      });
      await mappings.insert(mappingOf(M_BC_BROKEN, BACKEND_BC_SPEC, BACKEND_BC_APP, "active"));
      await artifacts.replaceChildren(M_BC_BROKEN, {
        // The primary's `dashB/id` response field is GONE — the dependent supplement's
        // chainInput.upstreamFieldPath `dashB/id` can no longer be populated (CO-7.3a).
        fieldMappings: [responseField(M_BC_BROKEN, "beta2/b_name", "dashB/name")],
        operationMappings: [
          opMapping(M_BC_BROKEN, "dashB/getDashB", "alpha2/getAlpha2"),
          opMapping(M_BC_BROKEN, "dashB/getDashB", "beta2/getBeta2"),
        ],
        parameterMappings: [],
      });

      // ── Endpoint BROKEN_PARAM: predecessor maps the required `gammaId`; successor drops it
      await mappings.insert(mappingOf(M_BP, BACKEND_PARAM_SPEC, BACKEND_PARAM_APP, "stale"));
      const bpOp = opMapping(M_BP, "item/getItem", "gamma/getGamma");
      const bpParam: ParameterMapping = {
        id: randomUUID(),
        operationMappingId: bpOp.id,
        sourceParamRef: "item/getItem#itemId",
        targetParamRef: "gamma/getGamma#gammaId",
      };
      await artifacts.replaceChildren(M_BP, {
        fieldMappings: [],
        operationMappings: [bpOp],
        parameterMappings: [bpParam],
      });
      await mappings.insert(
        mappingOf(M_BP_BROKEN, BACKEND_PARAM_SPEC, BACKEND_PARAM_APP, "active"),
      );
      await artifacts.replaceChildren(M_BP_BROKEN, {
        fieldMappings: [],
        // No ParameterMapping → required `gammaId` is uncovered and has no chainInput (CO-7.3b).
        operationMappings: [opMapping(M_BP_BROKEN, "item/getItem", "gamma/getGamma")],
        parameterMappings: [],
      });

      // ── An orphan predecessor mapping backing no binding (no-op adoption target) ─
      await mappings.insert(mappingOf(M_ORPHAN, BACKEND_CHAIN_SPEC, BACKEND_CHAIN_APP, "stale"));
      await artifacts.replaceChildren(M_ORPHAN, {
        fieldMappings: [],
        operationMappings: [opMapping(M_ORPHAN, "dashA/getDashA", "alpha/getAlpha")],
        parameterMappings: [],
      });

      // ── Endpoints + bindings (primary inserted before its chained supplement) ───
      await txn
        .insert(adapterEndpoint)
        .values(
          toAdapterEndpointInsert(endpointOf(ENDPOINT_CHAIN, "dashA/getDashA", "fanout-merge")),
        );
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: CHAIN_PRIMARY,
            endpointId: ENDPOINT_CHAIN,
            backendAppId: BACKEND_CHAIN_APP,
            backendOperationId: "alpha/getAlpha",
            approvedMappingId: M_CHAIN,
            role: "primary",
            executionOrder: 0,
          }),
        ),
      );
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: CHAIN_SUPPLEMENT,
            endpointId: ENDPOINT_CHAIN,
            backendAppId: BACKEND_CHAIN_APP,
            backendOperationId: "beta/getBeta",
            approvedMappingId: M_CHAIN,
            role: "supplement",
            executionOrder: 1,
            dependsOnBindingId: CHAIN_PRIMARY,
            chainInputs: [
              { upstreamFieldPath: "dashA/id", targetParamRef: "beta/getBeta#betaKey" },
            ],
          }),
        ),
      );

      await txn
        .insert(adapterEndpoint)
        .values(toAdapterEndpointInsert(endpointOf(ENDPOINT_BC, "dashB/getDashB", "fanout-merge")));
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: BC_PRIMARY,
            endpointId: ENDPOINT_BC,
            backendAppId: BACKEND_BC_APP,
            backendOperationId: "alpha2/getAlpha2",
            approvedMappingId: M_BC,
            role: "primary",
            executionOrder: 0,
          }),
        ),
      );
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: BC_SUPPLEMENT,
            endpointId: ENDPOINT_BC,
            backendAppId: BACKEND_BC_APP,
            backendOperationId: "beta2/getBeta2",
            approvedMappingId: M_BC,
            role: "supplement",
            executionOrder: 1,
            dependsOnBindingId: BC_PRIMARY,
            chainInputs: [
              { upstreamFieldPath: "dashB/id", targetParamRef: "beta2/getBeta2#betaKey2" },
            ],
          }),
        ),
      );

      await txn
        .insert(adapterEndpoint)
        .values(toAdapterEndpointInsert(endpointOf(ENDPOINT_PARAM, "item/getItem", "single")));
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: PARAM_BINDING,
            endpointId: ENDPOINT_PARAM,
            backendAppId: BACKEND_PARAM_APP,
            backendOperationId: "gamma/getGamma",
            approvedMappingId: M_BP,
            role: "primary",
          }),
        ),
      );
    });

    spy = new SpyEndpointInvalidator();
    service = new AdapterCompositionService({ db, newId: randomUUID, cacheInvalidator: spy });
  });

  afterAll(async () => {
    await cleanup(db);
    await db.$client.end();
  });

  async function loadBindings(endpointId: string): Promise<AdapterBinding[]> {
    return new AdapterCompositionRepository(db).listBindings(endpointId);
  }
  async function loadEndpoint(endpointId: string): Promise<AdapterEndpoint | undefined> {
    return new AdapterCompositionRepository(db).getEndpointById(endpointId);
  }
  async function auditRows(): Promise<
    { details: string | null; relatedMappingId: string | null }[]
  > {
    const rows = await db.select().from(auditLog).where(eq(auditLog.actor, ACTOR));
    return rows.map((row) => ({
      details: row.details ?? null,
      relatedMappingId: row.relatedMappingId ?? null,
    }));
  }

  it("CO-7.1/7.2/7.5: a compatible successor re-points in place, keeps the endpoint active, drops cache", async () => {
    const callsBefore = spy.calls.length;
    const result = await service.adoptSuccessor(
      { supersededMappingId: M_CHAIN, successorMappingId: M_CHAIN_OK },
      ACTOR,
    );

    expect(new Set(result.affectedEndpointIds)).toEqual(new Set([ENDPOINT_CHAIN]));
    expect(result.flaggedEndpointIds).toHaveLength(0);
    expect(new Set(result.repointedBindingIds)).toEqual(new Set([CHAIN_PRIMARY, CHAIN_SUPPLEMENT]));

    // Endpoint stays active — NOT sent through the proposed → composition-required path.
    const endpoint = await loadEndpoint(ENDPOINT_CHAIN);
    expect(endpoint?.status).toBe("active");

    const bindings = await loadBindings(ENDPOINT_CHAIN);
    // Same binding ids (re-pointed, not new proposed bindings); all active.
    expect(new Set(bindings.map((b) => b.id))).toEqual(new Set([CHAIN_PRIMARY, CHAIN_SUPPLEMENT]));
    expect(bindings.every((b) => b.status === "active")).toBe(true);
    // Re-pointed to the successor…
    expect(bindings.every((b) => b.approvedMappingId === M_CHAIN_OK)).toBe(true);
    // …with role / executionOrder / dependsOnBindingId / chainInputs preserved verbatim.
    const primary = bindings.find((b) => b.id === CHAIN_PRIMARY);
    const supplement = bindings.find((b) => b.id === CHAIN_SUPPLEMENT);
    expect(primary?.role).toBe("primary");
    expect(primary?.executionOrder).toBe(0);
    expect(supplement?.role).toBe("supplement");
    expect(supplement?.executionOrder).toBe(1);
    expect(supplement?.dependsOnBindingId).toBe(CHAIN_PRIMARY);
    expect(supplement?.chainInputs).toEqual([
      { upstreamFieldPath: "dashA/id", targetParamRef: "beta/getBeta#betaKey" },
    ]);

    // CO-7.5 — the affected endpoint's cache was dropped through the seam.
    expect(spy.calls.slice(callsBefore)).toContain(ENDPOINT_CHAIN);

    // One operator-attributed adoption audit row, metadata only (no secret).
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.relatedMappingId).toBe(M_CHAIN_OK);
    expect(audits[0]?.details).toContain("successor adopted");
    expect(audits[0]?.details).toContain("0 flagged");
  });

  it("CO-7.3a/7.4: a successor dropping a dependent's upstream response field flags composition-required", async () => {
    const callsBefore = spy.calls.length;
    const result = await service.adoptSuccessor(
      { supersededMappingId: M_BC, successorMappingId: M_BC_BROKEN },
      ACTOR,
    );

    expect(result.flaggedEndpointIds).toEqual([ENDPOINT_BC]);

    // Flagged composition-required — never a broken active.
    const endpoint = await loadEndpoint(ENDPOINT_BC);
    expect(endpoint?.status).toBe("composition-required");

    // Bindings are STILL re-pointed and active — staleness/adoption pauses composition, it
    // does not decompose the endpoint (CO-7.4: keeps serving where valid).
    const bindings = await loadBindings(ENDPOINT_BC);
    expect(bindings.every((b) => b.approvedMappingId === M_BC_BROKEN)).toBe(true);
    expect(bindings.every((b) => b.status === "active")).toBe(true);
    expect(spy.calls.slice(callsBefore)).toContain(ENDPOINT_BC);
  });

  it("CO-7.3b/7.4: a successor dropping a required parameter's mapping flags composition-required", async () => {
    const result = await service.adoptSuccessor(
      { supersededMappingId: M_BP, successorMappingId: M_BP_BROKEN },
      ACTOR,
    );

    expect(result.flaggedEndpointIds).toEqual([ENDPOINT_PARAM]);
    const endpoint = await loadEndpoint(ENDPOINT_PARAM);
    expect(endpoint?.status).toBe("composition-required");
    const bindings = await loadBindings(ENDPOINT_PARAM);
    expect(bindings[0]?.approvedMappingId).toBe(M_BP_BROKEN);
    expect(bindings[0]?.status).toBe("active");
  });

  it("idempotency: re-adopting the same pair re-points nothing — a clean no-op", async () => {
    const callsBefore = spy.calls.length;
    const auditsBefore = (await auditRows()).length;

    // The CHAIN bindings are already on M_CHAIN_OK, so nothing matches M_CHAIN anymore.
    const result = await service.adoptSuccessor(
      { supersededMappingId: M_CHAIN, successorMappingId: M_CHAIN_OK },
      ACTOR,
    );

    expect(result.repointedBindingIds).toHaveLength(0);
    expect(result.affectedEndpointIds).toHaveLength(0);
    expect(result.flaggedEndpointIds).toHaveLength(0);
    // No spurious cache drop, no spurious audit row, endpoint untouched.
    expect(spy.calls.length).toBe(callsBefore);
    expect((await auditRows()).length).toBe(auditsBefore);
    expect((await loadEndpoint(ENDPOINT_CHAIN))?.status).toBe("active");
  });

  it("no-op: adopting a mapping with no bindings is a clean no-op", async () => {
    const callsBefore = spy.calls.length;
    const auditsBefore = (await auditRows()).length;

    const result = await service.adoptSuccessor(
      { supersededMappingId: M_ORPHAN, successorMappingId: M_CHAIN_OK },
      ACTOR,
    );

    expect(result.repointedBindingIds).toHaveLength(0);
    expect(spy.calls.length).toBe(callsBefore);
    expect((await auditRows()).length).toBe(auditsBefore);
  });

  it("an unknown successor id is a clean NotFound (nothing re-pointed)", async () => {
    await expect(
      service.adoptSuccessor(
        { supersededMappingId: M_CHAIN_OK, successorMappingId: randomUUID() },
        ACTOR,
      ),
    ).rejects.toThrow(/not found/i);
  });
});
