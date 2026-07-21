import { fileURLToPath } from "node:url";

import type { APIRequestContext } from "@playwright/test";
import type { Database } from "@mediator/db";
import type { FieldMapping, Ir, IrOperation, IrSchema, OperationMapping } from "@mediator/domain";

import {
  attachProposedBinding,
  loadYamlSpecAsJson,
  registerConsumerApp,
  seedConsumerProviderMapping,
  seedProviderApp,
  seedResourceBinding,
  type RegisteredConsumer,
} from "./adapter-seed.js";
import {
  composeDown,
  composeUp,
  ensureEnvFile,
  isDockerAvailable,
  probe,
  probeAuthed,
  readToken,
  runIn,
  type LandscapeBringUp,
} from "./landscape-lib.js";

/**
 * The **CU-5 scenario-4 adapter capstone** landscape: three running PROVIDERs (Gitea +
 * Forgejo + Vikunja) + the `task-dashboard` CONSUMER surface. Its `GET /work-items` is a
 * **`collection-union`** over the three backends' global list/search operations — the
 * aggregation case CU-5.4/5.5/5.6 exercise against live containers.
 */

const SCENARIO_DIR = fileURLToPath(
  new URL("../../../../scenarios/scenario-4-mixed", import.meta.url),
);
const CONSUMER_SPEC_YAML = `${SCENARIO_DIR}/specs/consumer/task-dashboard.yaml`;
const TOKENS_FILE = `${SCENARIO_DIR}/.tokens.env`;

/** Fixed host ports from the scenario `.env` (port scheme `1<scenario><app>`). */
export const GITEA_PORT = 14300;
export const FORGEJO_PORT = 14350;
export const VIKUNJA_PORT = 14400;
export const GITEA_BASE_URL = `http://localhost:${String(GITEA_PORT)}/api/v1`;
export const FORGEJO_BASE_URL = `http://localhost:${String(FORGEJO_PORT)}/api/v1`;
export const VIKUNJA_BASE_URL = `http://localhost:${String(VIKUNJA_PORT)}/api/v1`;

/** The consumer op the union serves. */
export const CONSUMER_UNION_OP = "work-items/listWorkItems";
export const CONSUMER_UNION_PATH = "/work-items";

/** The per-backend unique titles (each proves its backend contributed to the merged union). */
export const UNIQUE_GITEA_TITLE = "Refactor CI pipeline";
export const UNIQUE_FORGEJO_TITLE = "Rotate deploy keys";
export const UNIQUE_VIKUNJA_TITLE = "Water the office plants";

// ── Faithful minimal PROVIDER IRs (real `/api/v1`-relative paths) ─────────────────────
function pathlessListOp(operationId: string, path: string, schema: IrSchema): IrOperation {
  return { operationId, method: "get", path, parameters: [], responseSchema: schema };
}

const ISSUE_SCHEMA: IrSchema = {
  name: "Issue",
  fields: [
    { name: "number", type: "integer", required: true },
    { name: "title", type: "string", required: true },
    { name: "body", type: "string", required: false },
    { name: "state", type: "string", required: false },
    { name: "updated_at", type: "string", required: false },
  ],
};
const TASK_SCHEMA: IrSchema = {
  name: "Task",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "title", type: "string", required: true },
    { name: "description", type: "string", required: false },
    { name: "done", type: "boolean", required: false },
    { name: "updated", type: "string", required: false },
  ],
};

function giteaIr(searchOp: string): Ir {
  return [
    {
      resourceRef: "issues",
      name: "issues",
      // The global issue search (no path params; the mediator paginates the merged union).
      operations: [pathlessListOp(searchOp, "/repos/issues/search", ISSUE_SCHEMA)],
      schemas: [ISSUE_SCHEMA],
      crossResourceRefs: [],
    },
  ];
}
const VIKUNJA_IR: Ir = [
  {
    resourceRef: "tasks",
    name: "tasks",
    operations: [pathlessListOp("vikunjaListTasks", "/tasks", TASK_SCHEMA)],
    schemas: [TASK_SCHEMA],
    crossResourceRefs: [],
  },
];

// ── Per-backend response-phase field mappings (backend row → WorkItem) ────────────────
function resp(sourcePath: string, targetPath: string): Omit<FieldMapping, "id" | "mappingId"> {
  return { sourcePath, targetPath, transform: "rename", phase: "response" };
}
function coerceIdToString(sourcePath: string): Omit<FieldMapping, "id" | "mappingId"> {
  return {
    sourcePath,
    targetPath: "work-items/itemId",
    transform: "coerce",
    transformConfig: { coerce: { to: "string", from: "number" } },
    phase: "response",
  };
}
/** open|closed → boolean `finished` (closed = finished). */
function coerceStateToFinished(sourcePath: string): Omit<FieldMapping, "id" | "mappingId"> {
  return {
    sourcePath,
    targetPath: "work-items/finished",
    transform: "coerce",
    transformConfig: {
      coerce: { to: "boolean", from: "enum", truthy: ["closed"], falsy: ["open"] },
    },
    phase: "response",
  };
}

/** Gitea/Forgejo issue → WorkItem (source resource `issues`). Required: itemId, headline, finished. */
const ISSUE_FIELD_MAPPINGS: readonly Omit<FieldMapping, "id" | "mappingId">[] = [
  coerceIdToString("issues/number"),
  resp("issues/title", "work-items/headline"),
  coerceStateToFinished("issues/state"),
  resp("issues/updated_at", "work-items/lastChanged"),
];
/** Vikunja task → WorkItem (source resource `tasks`). */
const TASK_FIELD_MAPPINGS: readonly Omit<FieldMapping, "id" | "mappingId">[] = [
  coerceIdToString("tasks/id"),
  resp("tasks/title", "work-items/headline"),
  resp("tasks/done", "work-items/finished"),
  resp("tasks/updated", "work-items/lastChanged"),
];

function readOp(target: string): Omit<OperationMapping, "id" | "mappingId"> {
  return { sourceOperationRef: CONSUMER_UNION_OP, targetOperationRef: target, action: "read" };
}

// ── Landscape lifecycle ───────────────────────────────────────────────────────────────
export interface Scenario4Tokens {
  readonly gitea: string;
  readonly forgejo: string;
  readonly vikunja: string;
}
export function readScenario4Tokens(): Scenario4Tokens {
  return {
    gitea: readToken(TOKENS_FILE, "GITEA_TOKEN"),
    forgejo: readToken(TOKENS_FILE, "FORGEJO_TOKEN"),
    vikunja: readToken(TOKENS_FILE, "VIKUNJA_TOKEN"),
  };
}

async function containersUp(): Promise<boolean> {
  const [gitea, forgejo, vikunja] = await Promise.all([
    probe(`http://localhost:${String(GITEA_PORT)}/api/healthz`),
    probe(`http://localhost:${String(FORGEJO_PORT)}/api/healthz`),
    probe(`${VIKUNJA_BASE_URL}/info`),
  ]);
  return gitea && forgejo && vikunja;
}

export async function isScenario4Ready(): Promise<boolean> {
  if (!(await containersUp())) {
    return false;
  }
  try {
    readScenario4Tokens();
    return true;
  } catch {
    return false;
  }
}

export async function ensureScenario4Landscape(): Promise<LandscapeBringUp> {
  if (await isScenario4Ready()) {
    return "reused";
  }
  const wasUp = await containersUp();
  if (!wasUp && !isDockerAvailable()) {
    return "unavailable";
  }
  ensureEnvFile(SCENARIO_DIR, [
    "GITEA_TAG=1.25.5",
    "FORGEJO_TAG=15.0.3",
    "VIKUNJA_TAG=2.3.0",
    `GITEA_PORT=${String(GITEA_PORT)}`,
    `FORGEJO_PORT=${String(FORGEJO_PORT)}`,
    `VIKUNJA_PORT=${String(VIKUNJA_PORT)}`,
  ]);
  if (!wasUp) {
    composeUp(SCENARIO_DIR);
  }
  runIn(SCENARIO_DIR, "bash", ["./bootstrap.sh"]);
  const tokens = readScenario4Tokens();
  if (!(await hasSeedData(tokens))) {
    runIn(SCENARIO_DIR, "bash", ["./seed.sh"]);
  }
  if (!(await isScenario4Ready())) {
    throw new Error("scenario-4 landscape did not become ready after bring-up");
  }
  return wasUp ? "reused" : "started";
}

async function hasSeedData(tokens: Scenario4Tokens): Promise<boolean> {
  return probeAuthed(`${GITEA_BASE_URL}/repos/alice/phoenix`, tokens.gitea);
}

export function teardownScenario4Landscape(): void {
  composeDown(SCENARIO_DIR);
}

// ── The mediator-side fixture ──────────────────────────────────────────────────────────
export interface Scenario4Fixture {
  readonly consumer: RegisteredConsumer;
  readonly endpointId: string;
  /** The three union contributor binding ids (Gitea, Forgejo, Vikunja). */
  readonly bindingIds: readonly string[];
  /** The three backend PROVIDER app ids (for the degraded-header + disable assertions). */
  readonly giteaAppId: string;
  readonly forgejoAppId: string;
  readonly vikunjaAppId: string;
  /** consumer + 3 provider app ids, for {@link cleanupAdapterApps}. */
  readonly appIds: readonly string[];
}

/**
 * Register the `task-dashboard` CONSUMER surface (real ingestion → mounts it), seed the
 * three provider backends (+ their ResourceBindings + one consumer-provider mapping each),
 * and stand up the union endpoint as `composition-required` with three `proposed`
 * `supplement` bindings — exactly the state a human composes into a `collection-union`.
 */
export async function seedScenario4Adapter(
  request: APIRequestContext,
  db: Database,
  tokens: Scenario4Tokens,
  suffix: string,
): Promise<Scenario4Fixture> {
  const consumer = await registerConsumerApp(request, {
    name: `cu5-task-dashboard-${suffix}`,
    document: loadYamlSpecAsJson(CONSUMER_SPEC_YAML),
  });

  const contributors = [
    {
      name: `cu5-gitea-${suffix}`,
      baseUrl: GITEA_BASE_URL,
      token: tokens.gitea,
      ir: giteaIr("giteaSearchIssues"),
      resourceRef: "issues",
      nativeIdField: "number",
      searchOp: "issues/giteaSearchIssues",
      fieldMappings: ISSUE_FIELD_MAPPINGS,
    },
    {
      name: `cu5-forgejo-${suffix}`,
      baseUrl: FORGEJO_BASE_URL,
      token: tokens.forgejo,
      ir: giteaIr("forgejoSearchIssues"),
      resourceRef: "issues",
      nativeIdField: "number",
      searchOp: "issues/forgejoSearchIssues",
      fieldMappings: ISSUE_FIELD_MAPPINGS,
    },
    {
      name: `cu5-vikunja-${suffix}`,
      baseUrl: VIKUNJA_BASE_URL,
      token: tokens.vikunja,
      ir: VIKUNJA_IR,
      resourceRef: "tasks",
      nativeIdField: "id",
      searchOp: "tasks/vikunjaListTasks",
      fieldMappings: TASK_FIELD_MAPPINGS,
    },
  ] as const;

  const appIds: string[] = [consumer.appId];
  const bindingIds: string[] = [];
  let endpointId = "";
  const backendAppIdByName: Record<string, string> = {};

  for (const contributor of contributors) {
    const provider = await seedProviderApp(db, {
      name: contributor.name,
      baseUrl: contributor.baseUrl,
      token: contributor.token,
      ir: contributor.ir,
    });
    appIds.push(provider.appId);
    backendAppIdByName[contributor.name] = provider.appId;
    await seedResourceBinding(db, {
      apiSpecId: provider.specId,
      resourceRef: contributor.resourceRef,
      nativeIdField: contributor.nativeIdField,
      collectionReadOp: contributor.searchOp.split("/")[1] ?? contributor.searchOp,
    });
    const mappingId = await seedConsumerProviderMapping(db, {
      consumer,
      provider,
      consumerAppId: consumer.appId,
      operationMappings: [readOp(contributor.searchOp)],
      parameterMappings: [],
      fieldMappings: contributor.fieldMappings,
    });
    const attached = await attachProposedBinding(db, {
      consumerAppId: consumer.appId,
      consumerOperationId: CONSUMER_UNION_OP,
      backendAppId: provider.appId,
      backendOperationId: contributor.searchOp,
      approvedMappingId: mappingId,
    });
    endpointId = attached.endpointId;
    bindingIds.push(attached.bindingId);
  }

  return {
    consumer,
    endpointId,
    bindingIds,
    giteaAppId: backendAppIdByName[`cu5-gitea-${suffix}`] ?? "",
    forgejoAppId: backendAppIdByName[`cu5-forgejo-${suffix}`] ?? "",
    vikunjaAppId: backendAppIdByName[`cu5-vikunja-${suffix}`] ?? "",
    appIds,
  };
}
