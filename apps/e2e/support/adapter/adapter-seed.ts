import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { expect, type APIRequestContext } from "@playwright/test";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  adapterBinding,
  adapterEndpoint,
  adapterWriteOutcome,
  apiSpec,
  approvedMapping,
  auditLog,
  credential,
  fieldMapping,
  graphEdge,
  mappingDetectionJob,
  mappingProposal,
  operationMapping,
  parameterMapping,
  registeredApp,
  resourceBinding,
  resourceBindingRef,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  FieldMapping,
  Ir,
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";
import { inArray, or } from "drizzle-orm";

import { BACKEND_ORIGIN, CREDENTIAL_MASTER_KEY, OPERATOR, basicAuthHeader } from "../env.js";

/**
 * The **mediator-side** seeding primitives for the CU-5 adapter capstone — the
 * consumer/provider apps, specs, consumer-provider `ApprovedMapping`s, and the
 * `AdapterEndpoint`/`AdapterBinding`s the Adapter Engine serves from. The LLM/mapping
 * is fixtured here (the established pattern — the adapter serve integration specs seed
 * `ApprovedMapping`s directly; the task permits "seed the approved mapping directly"),
 * while the *serving* is real: the running e2e backend's Adapter Server Runtime
 * resolves each inbound call against the **live** landscape containers.
 *
 * Where the fixture boundary sits:
 *  - the **consumer app + spec** are registered through the **real** `POST /api/apps`
 *    ingestion (so its `SpecIngested` mounts the surface live, RT-4.1, and the token
 *    becomes issuable) — the IR is what `@mediator/ir`'s `buildIr` derives, not a fake;
 *  - the **provider app + spec + credential** are seeded directly with a faithful
 *    minimal IR at the backend's **real** paths (the SU-6 `ir.ts` pattern), so every
 *    outbound call the engine composes hits the live container correctly;
 *  - the **`ApprovedMapping`** (request+response phases, parameter mappings) is seeded
 *    directly; the **`AdapterEndpoint`/`AdapterBinding`** are written in the exact
 *    shape CO-1 auto-activation produces (`single`/`primary`/`active` for a first
 *    binding; `composition-required` + `proposed` supplements for a union to compose).
 */

/** A consumer app registered through the real ingestion API. */
export interface RegisteredConsumer {
  readonly appId: string;
  readonly specId: string;
}

/** A provider app seeded directly (real baseUrl + credential + minimal IR). */
export interface SeededProvider {
  readonly appId: string;
  readonly specId: string;
}

/** A default capability set for a landscape app (poll interval is inert for the adapter path). */
function capabilities(): RegisteredApp["capabilities"] {
  return {
    supportsPolling: false,
    supportsDeltaQuery: false,
    supportsChangeTimestamps: false,
    defaultPollInterval: 24 * 60 * 60 * 1000,
  };
}

/**
 * Convert a committed YAML OpenAPI spec to a JSON document (via `python3` + PyYAML, a
 * documented scenario prerequisite). Faithful to the real CONSUMER spec under test —
 * never a hand-rolled equivalent — so a spec edit flows into the journey.
 */
export function loadYamlSpecAsJson(yamlPath: string): Record<string, unknown> {
  const json = execFileSync(
    "python3",
    [
      "-c",
      "import sys,yaml,json; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)",
      yamlPath,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Register a CONSUMER app + spec through the **real** `POST /api/apps` (AR-1). The
 * ingestion emits `SpecIngested`, which the adapter runtime's mount reaction turns
 * into a live route surface (RT-4.1), and makes the app adapter-token-eligible. A
 * consumer-only app carries no `baseUrl`/credential (the mediator never calls it).
 */
export async function registerConsumerApp(
  request: APIRequestContext,
  input: { name: string; document: Record<string, unknown> },
): Promise<RegisteredConsumer> {
  const response = await request.post(`${BACKEND_ORIGIN}/api/apps`, {
    headers: { authorization: basicAuthHeader(OPERATOR) },
    data: { name: input.name, specs: [{ role: "CONSUMER", document: input.document }] },
  });
  const text = await response.text();
  expect(response.status(), `register consumer ${input.name} → ${text}`).toBe(201);
  const body = JSON.parse(text) as { app: { id: string }; specs: { id: string; role: string }[] };
  const spec = body.specs.find((candidate) => candidate.role === "CONSUMER");
  if (spec === undefined) {
    throw new Error(`register ${input.name} returned no CONSUMER spec: ${text}`);
  }
  return { appId: body.app.id, specId: spec.id };
}

/** Issue a consumer app's adapter token through the real AT-1 route; returns the raw token (shown once). */
export async function issueAdapterToken(
  request: APIRequestContext,
  appId: string,
): Promise<{ token: string; credentialId: string }> {
  const response = await request.post(`${BACKEND_ORIGIN}/api/apps/${appId}/adapter-token`, {
    headers: { authorization: basicAuthHeader(OPERATOR) },
  });
  const text = await response.text();
  expect(response.status(), `issue token for ${appId} → ${text}`).toBe(201);
  const body = JSON.parse(text) as { token: string; credentialId: string };
  return { token: body.token, credentialId: body.credentialId };
}

/**
 * Seed a PROVIDER app directly: the real container `baseUrl`, its encrypted
 * `.tokens.env` credential (under the backend's own master key — they must match, or
 * `withCredential` cannot decrypt), and a faithful minimal PROVIDER IR at the real
 * paths. No `SpecIngested` is emitted (a provider spec is not mounted), which also
 * avoids a spurious detection run against it.
 */
export async function seedProviderApp(
  db: Database,
  input: { name: string; baseUrl: string; token: string; ir: Ir },
): Promise<SeededProvider> {
  const app: RegisteredApp = {
    id: randomUUID(),
    name: input.name,
    status: "active",
    baseUrl: input.baseUrl,
    capabilities: capabilities(),
    createdAt: new Date(),
  };
  const spec: ApiSpec = {
    id: randomUUID(),
    appId: app.id,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0", info: { title: input.name, version: "1" }, paths: {} },
    parsedIR: input.ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${randomUUID()}`,
    status: "active",
    createdAt: new Date(),
  };
  await new RegisteredAppRepository(db).create(app);
  await new ApiSpecRepository(db).create(spec);
  await new CredentialStore(
    new DbCredentialPersistence(db),
    new EnvKeyProvider(Buffer.from(CREDENTIAL_MASTER_KEY, "base64")),
    { info: () => undefined },
  ).store(app.id, { secret: { type: "apiKey", apiKey: input.token } });
  return { appId: app.id, specId: spec.id };
}

/**
 * Seed a confirmed `ResourceBinding` for a backend resource — the union serve path reads
 * its `nativeIdRef` (row provenance / records-path decision) and its **absent** `paginationRef`
 * (the confirmed-absence `single-page` case: one response is the whole collection, fine for the
 * small seeded landscape). `collectionReadRef` names the list operation.
 */
export async function seedResourceBinding(
  db: Database,
  input: {
    apiSpecId: string;
    resourceRef: string;
    nativeIdField: string;
    collectionReadOp: string;
  },
): Promise<void> {
  const now = new Date();
  const binding: ResourceBinding = {
    id: randomUUID(),
    apiSpecId: input.apiSpecId,
    resourceRef: input.resourceRef,
    nativeIdRef: {
      value: { kind: "field", path: input.nativeIdField },
      confirmedBy: "cu5-capstone-fixture",
      confirmedAt: now,
    },
    collectionReadRef: {
      value: { kind: "operation", operationId: input.collectionReadOp },
      confirmedBy: "cu5-capstone-fixture",
      confirmedAt: now,
    },
    scopePathBindings: [],
  };
  await new ResourceBindingRepository(db).createMany([binding]);
}

/** One consumer-provider `ApprovedMapping` to seed: its spec/app pair + its children. */
export interface ConsumerProviderMappingInput {
  readonly consumer: RegisteredConsumer;
  readonly provider: SeededProvider;
  readonly consumerAppId: string;
  readonly operationMappings: readonly Omit<OperationMapping, "id" | "mappingId">[];
  readonly parameterMappings: readonly Omit<ParameterMapping, "id" | "operationMappingId">[];
  readonly fieldMappings: readonly Omit<FieldMapping, "id" | "mappingId">[];
}

/**
 * Seed one consumer-provider `ApprovedMapping` + its operation/parameter/field
 * children directly. Each parameter mapping attaches to the operation mapping whose
 * `sourceOperationRef` matches its `sourceParamRef` prefix (before `#`), so a mapping
 * covering both a read and a write op wires each param to the right operation. Returns
 * the mapping id.
 */
export async function seedConsumerProviderMapping(
  db: Database,
  input: ConsumerProviderMappingInput,
): Promise<string> {
  const mappingId = randomUUID();
  await db.insert(approvedMapping).values({
    id: mappingId,
    sourceSpecId: input.consumer.specId,
    targetSpecId: input.provider.specId,
    sourceAppId: input.consumerAppId,
    targetAppId: input.provider.appId,
    variant: "consumer-provider",
    approvedBy: "cu5-capstone-fixture",
    approvedAt: new Date(),
    status: "active",
  });
  const operationMappings: OperationMapping[] = input.operationMappings.map((op) => ({
    ...op,
    id: randomUUID(),
    mappingId,
  }));
  if (operationMappings.length === 0) {
    throw new Error("a consumer-provider mapping needs at least one operation mapping");
  }
  const opIdByRef = new Map(operationMappings.map((op) => [op.sourceOperationRef, op.id]));
  const parameterMappings: ParameterMapping[] = input.parameterMappings.map((param) => {
    const opRef = param.sourceParamRef.split("#")[0] ?? "";
    const operationMappingId = opIdByRef.get(opRef);
    if (operationMappingId === undefined) {
      throw new Error(
        `parameter ${param.sourceParamRef} has no operation mapping for source op ${opRef}`,
      );
    }
    return { ...param, id: randomUUID(), operationMappingId };
  });
  const fieldMappings: FieldMapping[] = input.fieldMappings.map((field) => ({
    ...field,
    id: randomUUID(),
    mappingId,
  }));
  await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
    fieldMappings,
    operationMappings,
    parameterMappings,
  });
  return mappingId;
}

/**
 * Write an `AdapterEndpoint` + a single `active`/`primary` binding — the exact shape
 * CO-1 auto-activation produces for a consumer operation's **first** approved binding
 * (`single` strategy, no composition step). Returns the endpoint + binding ids.
 */
export async function activateSingleBindingEndpoint(
  db: Database,
  input: {
    consumerAppId: string;
    consumerOperationId: string;
    backendAppId: string;
    backendOperationId: string;
    approvedMappingId: string;
  },
): Promise<{ endpointId: string; bindingId: string }> {
  const artifacts = new DownstreamArtifactRepository(db);
  const endpoint: AdapterEndpoint = {
    id: randomUUID(),
    consumerAppId: input.consumerAppId,
    consumerOperationId: input.consumerOperationId,
    status: "active",
    aggregationStrategy: "single",
  };
  await artifacts.ensureAdapterEndpoint(endpoint);
  const binding: AdapterBinding = {
    id: randomUUID(),
    adapterEndpointId: endpoint.id,
    backendAppId: input.backendAppId,
    backendOperationId: input.backendOperationId,
    approvedMappingId: input.approvedMappingId,
    role: "primary",
    status: "active",
  };
  await artifacts.insertAdapterBindingIfAbsent(binding);
  return { endpointId: endpoint.id, bindingId: binding.id };
}

/**
 * Ensure a `composition-required` endpoint and attach one `proposed` binding to it —
 * the shape CO-1 produces for a **further** binding on an operation that already has
 * one, awaiting a human composition (CU-5.4). Idempotent on the endpoint. Returns the
 * proposed binding's id.
 */
export async function attachProposedBinding(
  db: Database,
  input: {
    consumerAppId: string;
    consumerOperationId: string;
    backendAppId: string;
    backendOperationId: string;
    approvedMappingId: string;
  },
): Promise<{ endpointId: string; bindingId: string }> {
  const artifacts = new DownstreamArtifactRepository(db);
  const endpoint: AdapterEndpoint = {
    id: randomUUID(),
    consumerAppId: input.consumerAppId,
    consumerOperationId: input.consumerOperationId,
    status: "composition-required",
  };
  const ensured = await artifacts.ensureAdapterEndpoint(endpoint);
  const binding: AdapterBinding = {
    id: randomUUID(),
    adapterEndpointId: ensured.id,
    backendAppId: input.backendAppId,
    backendOperationId: input.backendOperationId,
    approvedMappingId: input.approvedMappingId,
    role: "supplement",
    status: "proposed",
  };
  await artifacts.insertAdapterBindingIfAbsent(binding);
  return { endpointId: ensured.id, bindingId: binding.id };
}

/** The result of a compose/recompose API call (status + raw body for assertions). */
export interface ComposeResponse {
  readonly status: number;
  readonly text: string;
}

/**
 * Compose (or recompose) an adapter endpoint through the **real** operator API — the exact
 * `POST /api/adapter-endpoints/:id/compose` route the composition UI submits to
 * (`useComposeAdapterEndpoint`). The route dispatches by endpoint status: a
 * `composition-required` endpoint is composed, an `active` one recomposed, both running the
 * same CO-2/CO-3 validation and activating atomically.
 */
export async function composeAdapterEndpoint(
  request: APIRequestContext,
  endpointId: string,
  body: unknown,
): Promise<ComposeResponse> {
  const response = await request.post(
    `${BACKEND_ORIGIN}/api/adapter-endpoints/${endpointId}/compose`,
    { headers: { authorization: basicAuthHeader(OPERATOR) }, data: body },
  );
  return { status: response.status(), text: await response.text() };
}

/** Flip a backend app's lifecycle status (the CU-5.6 disable/re-enable probe). */
export async function setAppStatus(
  db: Database,
  appId: string,
  status: RegisteredApp["status"],
): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await db.update(registeredApp).set({ status }).where(eq(registeredApp.id, appId));
}

/**
 * Remove everything the fixture created for the given app ids (consumer + providers),
 * in FK-safe order, plus any detection artifacts the consumer ingestion incidentally
 * enqueued. Idempotent — safe to call from `afterAll` even if setup half-completed.
 */
export async function cleanupAdapterApps(db: Database, appIds: readonly string[]): Promise<void> {
  if (appIds.length === 0) {
    return;
  }
  const mutableAppIds = [...appIds];

  // Endpoints + their bindings/write-outcomes (keyed on the consumer app).
  const endpointRows = await db
    .select({ id: adapterEndpoint.id })
    .from(adapterEndpoint)
    .where(inArray(adapterEndpoint.consumerAppId, mutableAppIds));
  const endpointIds = endpointRows.map((row) => row.id);
  if (endpointIds.length > 0) {
    await db
      .delete(adapterWriteOutcome)
      .where(inArray(adapterWriteOutcome.adapterEndpointId, endpointIds));
    await db.delete(adapterBinding).where(inArray(adapterBinding.adapterEndpointId, endpointIds));
    await db.delete(adapterEndpoint).where(inArray(adapterEndpoint.id, endpointIds));
  }

  // Mappings + their children (keyed on either side's app id).
  const mappingRows = await db
    .select({ id: approvedMapping.id })
    .from(approvedMapping)
    .where(
      or(
        inArray(approvedMapping.sourceAppId, mutableAppIds),
        inArray(approvedMapping.targetAppId, mutableAppIds),
      ),
    );
  const mappingIds = mappingRows.map((row) => row.id);
  if (mappingIds.length > 0) {
    const opRows = await db
      .select({ id: operationMapping.id })
      .from(operationMapping)
      .where(inArray(operationMapping.mappingId, mappingIds));
    const opIds = opRows.map((row) => row.id);
    if (opIds.length > 0) {
      await db.delete(parameterMapping).where(inArray(parameterMapping.operationMappingId, opIds));
    }
    await db.delete(operationMapping).where(inArray(operationMapping.mappingId, mappingIds));
    await db.delete(fieldMapping).where(inArray(fieldMapping.mappingId, mappingIds));
    await db.delete(approvedMapping).where(inArray(approvedMapping.id, mappingIds));
  }

  // Detection artifacts the consumer `SpecIngested` may have enqueued (LLM-free noise).
  const specRows = await db
    .select({ id: apiSpec.id })
    .from(apiSpec)
    .where(inArray(apiSpec.appId, mutableAppIds));
  const specIds = specRows.map((row) => row.id);
  if (specIds.length > 0) {
    await db.delete(mappingDetectionJob).where(inArray(mappingDetectionJob.apiSpecId, specIds));
    await db
      .delete(mappingProposal)
      .where(
        or(
          inArray(mappingProposal.sourceSpecId, specIds),
          inArray(mappingProposal.targetSpecId, specIds),
        ),
      );
  }

  // Audit rows: adapter-request rows (actor `consumer-app:<id>`) + operator credential
  // rows attributed to these apps (`originAppId`).
  await db.delete(auditLog).where(
    or(
      inArray(
        auditLog.actor,
        mutableAppIds.map((id) => `consumer-app:${id}`),
      ),
      inArray(auditLog.originAppId, mutableAppIds),
    ),
  );

  await db.delete(credential).where(inArray(credential.appId, mutableAppIds));
  // resource_binding(+_ref) do NOT cascade from api_spec — delete them first (the
  // consumer registration derives unconfirmed bindings for its ingested spec, RB-1).
  if (specIds.length > 0) {
    const bindingRows = await db
      .select({ id: resourceBinding.id })
      .from(resourceBinding)
      .where(inArray(resourceBinding.apiSpecId, specIds));
    const bindingIds = bindingRows.map((row) => row.id);
    if (bindingIds.length > 0) {
      await db
        .delete(resourceBindingRef)
        .where(inArray(resourceBindingRef.resourceBindingId, bindingIds));
      await db.delete(resourceBinding).where(inArray(resourceBinding.id, bindingIds));
    }
  }
  await db.delete(apiSpec).where(inArray(apiSpec.appId, mutableAppIds));
  await db
    .delete(graphEdge)
    .where(
      or(
        inArray(graphEdge.sourceNodeId, mutableAppIds),
        inArray(graphEdge.targetNodeId, mutableAppIds),
      ),
    );
  await db.delete(registeredApp).where(inArray(registeredApp.id, mutableAppIds));
}
