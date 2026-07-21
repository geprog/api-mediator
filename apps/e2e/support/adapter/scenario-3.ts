import { fileURLToPath } from "node:url";

import type { APIRequestContext } from "@playwright/test";
import type { Database } from "@mediator/db";
import type { FieldMapping, Ir, IrOperation, IrSchema, OperationMapping } from "@mediator/domain";

import {
  activateSingleBindingEndpoint,
  loadYamlSpecAsJson,
  registerConsumerApp,
  seedConsumerProviderMapping,
  seedProviderApp,
  type RegisteredConsumer,
  type SeededProvider,
} from "./adapter-seed.js";
import { VikunjaClient } from "./backend-clients.js";
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
 * The **CU-5 scenario-3 adapter capstone** landscape: one running Vikunja PROVIDER +
 * the `todo-widget` CONSUMER surface, hosted by the mediator's Adapter Server Runtime.
 * This module owns the container lifecycle and the mediator-side fixture (the consumer
 * registration, the seeded consumer-provider `ApprovedMapping`, and the two
 * auto-activated single-binding endpoints) for the real round trips CU-5.1..5.3/5.7/5.8
 * exercise against the live Vikunja.
 */

const SCENARIO_DIR = fileURLToPath(
  new URL("../../../../scenarios/scenario-3-consumer-provider", import.meta.url),
);
const CONSUMER_SPEC_YAML = `${SCENARIO_DIR}/specs/consumer/todo-widget.yaml`;
const TOKENS_FILE = `${SCENARIO_DIR}/.tokens.env`;

/** Fixed host port from the scenario `.env` (port scheme `1<scenario><app>`). */
export const VIKUNJA_PORT = 13400;
export const VIKUNJA_BASE_URL = `http://localhost:${String(VIKUNJA_PORT)}/api/v1`;
/** The project `seed.sh` creates — the write's real target "list". */
export const VIKUNJA_PROJECT_TITLE = "phoenix";

// ── The consumer IR refs (what `buildIr` derives from `todo-widget.yaml`) ─────────────
export const CONSUMER_LIST_OP = "todos/listTodos";
export const CONSUMER_CREATE_OP = "todos/createTodo";
export const CONSUMER_COMPLETE_OP = "todos/completeTodo";

/** The consumer op paths the adapter surface routes (from the spec's `paths`). */
export const CONSUMER_LIST_PATH = "/todos";
export const consumerCreatePath = (listId: string): string => `/lists/${listId}/todos`;
export const consumerCompletePath = (todoId: string): string => `/todos/${todoId}/complete`;

// ── The faithful minimal Vikunja PROVIDER IR (real `/api/v1`-relative paths) ──────────
//
// The read binds to the `tasks` collection (`GET /tasks`) and the write to the `projects`
// collection (`PUT /projects/{id}/tasks`, Vikunja creates with PUT). Modeling the create
// under `projects` (its leading path collection) keeps the read's `todos↔tasks` resource
// pair distinct from the write's `todos↔projects` pair — so the read never inherits the
// write's request-phase body mappings (the serve loader scopes field mappings by resource
// pair, `serve-context.ts`).
const TASK_FIELDS: IrSchema["fields"] = [
  { name: "id", type: "integer", required: true },
  { name: "title", type: "string", required: true },
  { name: "description", type: "string", required: false },
  { name: "done", type: "boolean", required: false },
  { name: "due_date", type: "string", required: false },
  { name: "updated", type: "string", required: false },
];
const VIKUNJA_TASK_SCHEMA: IrSchema = { name: "Task", fields: TASK_FIELDS };
const VIKUNJA_CREATED_TASK_SCHEMA: IrSchema = { name: "CreatedTask", fields: TASK_FIELDS };

function pathParam(name: string): IrOperation["parameters"][number] {
  return { name, location: "path", required: true, type: "string" };
}

const VIKUNJA_IR: Ir = [
  {
    resourceRef: "tasks",
    name: "tasks",
    operations: [
      // Global list — the param-free collection `listTodos` binds to.
      {
        operationId: "vikunjaListTasks",
        method: "get",
        path: "/tasks",
        parameters: [],
        responseSchema: VIKUNJA_TASK_SCHEMA,
      },
    ],
    schemas: [VIKUNJA_TASK_SCHEMA],
    crossResourceRefs: [],
  },
  {
    resourceRef: "projects",
    name: "projects",
    operations: [
      // Create in a project — Vikunja creates with PUT (the ground-truth write target);
      // `{id}` (the project) is filled from the consumer's `listId` parameter mapping.
      {
        operationId: "vikunjaCreateTask",
        method: "put",
        path: "/projects/{id}/tasks",
        parameters: [pathParam("id")],
        requestSchema: {
          name: "NewTask",
          fields: [
            { name: "title", type: "string", required: false },
            { name: "description", type: "string", required: false },
            { name: "due_date", type: "string", required: false },
          ],
        },
        responseSchema: VIKUNJA_CREATED_TASK_SCHEMA,
      },
    ],
    schemas: [VIKUNJA_CREATED_TASK_SCHEMA],
    crossResourceRefs: [],
  },
];

// ── The consumer-provider mapping (request + response phases, one parameter mapping) ──

/** A response-phase (backend→consumer) rename. */
function resp(sourcePath: string, targetPath: string): Omit<FieldMapping, "id" | "mappingId"> {
  return { sourcePath, targetPath, transform: "rename", phase: "response" };
}
/** A response-phase int→string coercion (Vikunja `id` → the string `todoId`). */
function respCoerceIdToString(
  sourcePath: string,
  targetPath: string,
): Omit<FieldMapping, "id" | "mappingId"> {
  return {
    sourcePath,
    targetPath,
    transform: "coerce",
    transformConfig: { coerce: { to: "string", from: "number" } },
    phase: "response",
  };
}
/** A request-phase (consumer→backend) rename. */
function req(sourcePath: string, targetPath: string): Omit<FieldMapping, "id" | "mappingId"> {
  return { sourcePath, targetPath, transform: "rename", phase: "request" };
}

const OPERATION_MAPPINGS: readonly Omit<OperationMapping, "id" | "mappingId">[] = [
  {
    sourceOperationRef: CONSUMER_LIST_OP,
    targetOperationRef: "tasks/vikunjaListTasks",
    action: "read",
  },
  {
    sourceOperationRef: CONSUMER_CREATE_OP,
    targetOperationRef: "projects/vikunjaCreateTask",
    action: "create",
  },
];

const FIELD_MAPPINGS: readonly Omit<FieldMapping, "id" | "mappingId">[] = [
  // ── Read pair (todos↔tasks): response phase only — Vikunja task → TodoItem. ──
  respCoerceIdToString("tasks/id", "todos/todoId"),
  resp("tasks/title", "todos/name"),
  resp("tasks/description", "todos/notes"),
  resp("tasks/done", "todos/done"),
  resp("tasks/due_date", "todos/due"),
  resp("tasks/updated", "todos/updatedAt"),
  // ── Write pair (todos↔projects): request phase (NewTodo → Vikunja create body) ──
  req("todos/name", "projects/title"),
  req("todos/notes", "projects/description"),
  req("todos/due", "projects/due_date"),
  // ── Write pair: response phase (created task → TodoItem) ──
  respCoerceIdToString("projects/id", "todos/todoId"),
  resp("projects/title", "todos/name"),
  resp("projects/description", "todos/notes"),
  resp("projects/done", "todos/done"),
  resp("projects/due_date", "todos/due"),
  resp("projects/updated", "todos/updatedAt"),
];

const PARAMETER_MAPPINGS = [
  // listId → project id path parameter.
  { sourceParamRef: "todos/createTodo#listId", targetParamRef: "projects/vikunjaCreateTask#id" },
] as const;

// ── Landscape lifecycle ───────────────────────────────────────────────────────────────

/** The Vikunja token `bootstrap.sh` writes to the gitignored `.tokens.env`. */
export function readScenario3Token(): string {
  return readToken(TOKENS_FILE, "VIKUNJA_TOKEN");
}

/** A REST client for the live Vikunja container (the journey's own backend assertions). */
export function scenario3Vikunja(token: string): VikunjaClient {
  return new VikunjaClient(VIKUNJA_BASE_URL, token);
}

async function containersUp(): Promise<boolean> {
  return probe(`${VIKUNJA_BASE_URL}/info`);
}

/** Reachable AND bootstrapped: Vikunja answers and `.tokens.env` carries its token. */
export async function isScenario3Ready(): Promise<boolean> {
  if (!(await containersUp())) {
    return false;
  }
  try {
    readScenario3Token();
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the scenario-3 landscape ready, reusing a running one as-is (never tearing a
 * developer's landscape down). `bootstrap.sh` is idempotent; `seed.sh` (create-only)
 * runs only when its fixtures are absent. Returns `started` only when *this* call ran
 * `docker compose up`.
 */
export async function ensureScenario3Landscape(): Promise<LandscapeBringUp> {
  if (await isScenario3Ready()) {
    return "reused";
  }
  const wasUp = await containersUp();
  if (!wasUp && !isDockerAvailable()) {
    return "unavailable";
  }
  ensureEnvFile(SCENARIO_DIR, ["VIKUNJA_TAG=2.3.0", `VIKUNJA_PORT=${String(VIKUNJA_PORT)}`]);
  if (!wasUp) {
    composeUp(SCENARIO_DIR);
  }
  runIn(SCENARIO_DIR, "bash", ["./bootstrap.sh"]);
  const token = readScenario3Token();
  if (!(await hasSeedData(token))) {
    runIn(SCENARIO_DIR, "bash", ["./seed.sh"]);
  }
  if (!(await isScenario3Ready())) {
    throw new Error("scenario-3 landscape did not become ready after bring-up");
  }
  return wasUp ? "reused" : "started";
}

/** Whether `seed.sh` fixtures (the phoenix project) already exist. */
async function hasSeedData(token: string): Promise<boolean> {
  return probeAuthed(`${VIKUNJA_BASE_URL}/projects`, token);
}

/** Tear the landscape down — only for a landscape this run started. */
export function teardownScenario3Landscape(): void {
  composeDown(SCENARIO_DIR);
}

// ── The mediator-side fixture ──────────────────────────────────────────────────────────

/** Everything the scenario-3 seed created — the ids a journey drives and cleans up. */
export interface Scenario3Fixture {
  readonly consumer: RegisteredConsumer;
  readonly provider: SeededProvider;
  readonly mappingId: string;
  readonly listEndpointId: string;
  readonly createEndpointId: string;
  /** consumer + provider app ids, for {@link cleanupAdapterApps}. */
  readonly appIds: readonly string[];
}

/**
 * Register the `todo-widget` CONSUMER surface (real ingestion → mounts it), seed the
 * Vikunja provider + the consumer-provider mapping, and auto-activate the two
 * single-binding endpoints (`listTodos`, `createTodo`). `completeTodo` is deliberately
 * left unmapped — the CU-5.7 `not-yet-mapped` probe.
 */
export async function seedScenario3Adapter(
  request: APIRequestContext,
  db: Database,
  vikunjaToken: string,
  appNameSuffix: string,
): Promise<Scenario3Fixture> {
  const consumer = await registerConsumerApp(request, {
    name: `cu5-todo-widget-${appNameSuffix}`,
    document: loadYamlSpecAsJson(CONSUMER_SPEC_YAML),
  });
  const provider = await seedProviderApp(db, {
    name: `cu5-vikunja-${appNameSuffix}`,
    baseUrl: VIKUNJA_BASE_URL,
    token: vikunjaToken,
    ir: VIKUNJA_IR,
  });
  const mappingId = await seedConsumerProviderMapping(db, {
    consumer,
    provider,
    consumerAppId: consumer.appId,
    operationMappings: OPERATION_MAPPINGS,
    parameterMappings: PARAMETER_MAPPINGS,
    fieldMappings: FIELD_MAPPINGS,
  });
  const list = await activateSingleBindingEndpoint(db, {
    consumerAppId: consumer.appId,
    consumerOperationId: CONSUMER_LIST_OP,
    backendAppId: provider.appId,
    backendOperationId: "tasks/vikunjaListTasks",
    approvedMappingId: mappingId,
  });
  const create = await activateSingleBindingEndpoint(db, {
    consumerAppId: consumer.appId,
    consumerOperationId: CONSUMER_CREATE_OP,
    backendAppId: provider.appId,
    backendOperationId: "projects/vikunjaCreateTask",
    approvedMappingId: mappingId,
  });
  return {
    consumer,
    provider,
    mappingId,
    listEndpointId: list.endpointId,
    createEndpointId: create.endpointId,
    appIds: [consumer.appId, provider.appId],
  };
}
