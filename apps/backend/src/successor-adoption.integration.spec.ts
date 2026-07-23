import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  SyncFieldStateRepository,
  SyncRuleRepository,
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  createDb,
  graphEdge,
  recordLink,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  syncFieldState,
  syncRule,
  toAdapterBindingInsert,
  toAdapterEndpointInsert,
  tx,
  type Database,
} from "@mediator/db";
import {
  MAPPING_APPROVED_EVENT_TYPE,
  type ApiSpec,
  type FieldMapping,
  type Ir,
  type OperationMapping,
  type RecordLink,
  type RegisteredApp,
  type SyncFieldState,
  type SyncRule,
} from "@mediator/domain";
import type { DeliveredEvent } from "@mediator/event-bus";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AdapterCompositionService,
  type EndpointCacheInvalidator,
} from "./modules/adapter-composition/index.js";
import { canonicalResourcePairRef } from "./modules/artifact-instantiation/derive.js";
import { buildArtifactInstantiation } from "./modules/artifact-instantiation/index.js";
import { GraphProjection } from "./modules/graph/index.js";

/**
 * **SL-7 / SL-8 — live-Postgres integration for successor adoption through the REAL
 * `MappingApproved` consumer (the live Phase-6 trigger CO-7 was built to receive).** It
 * drives {@link buildArtifactInstantiation}'s consumer over live Postgres, with the real
 * repositories, the real {@link GraphProjection}, and the real
 * {@link AdapterCompositionService.adoptSuccessor}. A seeded stale predecessor + its
 * successor (carrying `predecessorMappingId`) are adopted by delivering the successor's
 * `MappingApproved`, proving end to end:
 *  - **sync (SL-7.1/8.1):** the predecessor's `SyncRule`s re-point to the successor
 *    (`approvedMappingId` only), keeping cursor/snapshot/backfill/enablement/pollOperationRef;
 *  - **supersede (SL-7.1):** the stale predecessor becomes `superseded`;
 *  - **counterpart (SL-7.3):** the peer pairing transfers to the successor;
 *  - **records (SL-8.3):** `RecordLink`/`SyncFieldState` are untouched;
 *  - **graph (SL-7.7):** the sync `GraphEdge` recomputes for the successor;
 *  - **adapter (SL-7.5):** a consumer-provider successor drives CO-7 `adoptSuccessor`, which
 *    re-points the `AdapterBinding` in place — the live trigger, not a simulated one.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`. Self-skips when unresolvable. Run in isolation (the shared-DB integration
 * suite is flaky across files); its teardown deletes everything it writes, FK-safe.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-22T00:00:00.000Z");
const OBSERVED_AT = new Date("2026-07-22T01:00:00.000Z");

// Peer-peer scenario ids.
const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A_OLD = randomUUID();
const SPEC_A_NEW = randomUUID();
const SPEC_B = randomUUID();
const M_PRED = randomUUID();
const M_CP = randomUUID();
const M_SUCC = randomUUID();
const RULE_ISSUES = randomUUID();
const RULE_COMMENTS = randomUUID();
const SNAPSHOT_ISSUES = randomUUID();
const LINK_ID = randomUUID();

// Consumer-provider scenario ids.
const CONS_APP = randomUUID();
const BACK_APP = randomUUID();
const SPEC_CONS = randomUUID();
const SPEC_BACK = randomUUID();
const MP_PRED = randomUUID();
const MP_SUCC = randomUUID();
const ENDPOINT = randomUUID();
const BINDING = randomUUID();

const ALL_APP_IDS = [APP_A, APP_B, CONS_APP, BACK_APP];
const ALL_SPEC_IDS = [SPEC_A_OLD, SPEC_A_NEW, SPEC_B, SPEC_CONS, SPEC_BACK];
const ALL_MAPPING_IDS = [M_PRED, M_CP, M_SUCC, MP_PRED, MP_SUCC];

const ISSUES_PAIR = canonicalResourcePairRef(
  { appId: APP_A, resourceRef: "issues" },
  { appId: APP_B, resourceRef: "tasks" },
);
const COMMENTS_PAIR = canonicalResourcePairRef(
  { appId: APP_A, resourceRef: "comments" },
  { appId: APP_B, resourceRef: "notes" },
);

class SpyEndpointInvalidator implements EndpointCacheInvalidator {
  public readonly calls: string[] = [];
  public invalidateEndpoint(endpointId: string): void {
    this.calls.push(endpointId);
  }
}

function appOf(id: string, name: string, supportsPolling: boolean): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: CREATED_AT,
  };
}

function specOf(
  id: string,
  appId: string,
  role: ApiSpec["role"],
  ir: Ir,
  status: ApiSpec["status"],
  version: number,
): ApiSpec {
  return {
    id,
    appId,
    role,
    rawDocument: { openapi: "3.1.0" },
    parsedIR: ir,
    analysisExclusions: [],
    version,
    contentHash: `sha256:${id}`,
    status,
    createdAt: CREATED_AT,
  };
}

/** A one-read-operation resource group with an optional single-field response schema. */
function group(resourceRef: string, operationId: string, responseField?: string): Ir[number] {
  return {
    resourceRef,
    name: resourceRef,
    operations: [
      {
        operationId,
        method: "get",
        path: `/${resourceRef}`,
        parameters: [],
        ...(responseField !== undefined
          ? {
              responseSchema: {
                name: `${resourceRef}Response`,
                fields: [{ name: responseField, type: "string", required: false }],
              },
            }
          : {}),
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

function peerField(mappingId: string, sourcePath: string, targetPath: string): FieldMapping {
  return { id: randomUUID(), mappingId, sourcePath, targetPath, transform: "rename" };
}

function ruleOf(input: {
  id: string;
  mappingId: string;
  resourcePairRef: string;
  cursor: string | null;
  lastSnapshotRef: string | null;
  pollOperationRef?: string;
}): SyncRule {
  return {
    id: input.id,
    approvedMappingId: input.mappingId,
    resourcePairRef: input.resourcePairRef,
    status: "enabled",
    backfillStatus: "completed",
    cursor: input.cursor,
    lastSnapshotRef: input.lastSnapshotRef,
    ...(input.pollOperationRef !== undefined ? { pollOperationRef: input.pollOperationRef } : {}),
  };
}

async function cleanup(db: Database): Promise<void> {
  await db.delete(syncFieldState).where(inArray(syncFieldState.recordLinkId, [LINK_ID]));
  await db.delete(recordLink).where(inArray(recordLink.id, [LINK_ID]));
  await db.delete(auditLog);
  await db.delete(syncRule).where(inArray(syncRule.approvedMappingId, ALL_MAPPING_IDS));
  await db.delete(adapterBinding).where(inArray(adapterBinding.approvedMappingId, ALL_MAPPING_IDS));
  await db.delete(adapterEndpoint).where(inArray(adapterEndpoint.id, [ENDPOINT]));
  await db.delete(graphEdge).where(inArray(graphEdge.sourceNodeId, ALL_APP_IDS));
  // approvedMapping delete cascades its field/operation/parameter mapping children.
  await db.delete(approvedMapping).where(inArray(approvedMapping.id, ALL_MAPPING_IDS));
  await db.delete(apiSpec).where(inArray(apiSpec.id, ALL_SPEC_IDS));
  await db.delete(registeredApp).where(inArray(registeredApp.id, ALL_APP_IDS));
}

suite(
  "Phase-6 SL-7/SL-8 successor adoption via the MappingApproved consumer (requires Postgres)",
  () => {
    let db: Database;
    let consumer: ReturnType<typeof buildArtifactInstantiation>["consumer"];
    let cacheSpy: SpyEndpointInvalidator;

    beforeAll(async () => {
      db = createDb(databaseUrl ?? "");
      await runMigrations(db);
      await cleanup(db);

      await tx(db, async (txn) => {
        const apps = new RegisteredAppRepository(txn);
        await apps.create(appOf(APP_A, "adopt-a", true));
        await apps.create(appOf(APP_B, "adopt-b", true));
        await apps.create(appOf(CONS_APP, "adopt-consumer", false));
        await apps.create(appOf(BACK_APP, "adopt-backend", false));

        const specs = new ApiSpecRepository(txn);
        await specs.create(specOf(SPEC_A_OLD, APP_A, "PROVIDER", [], "superseded", 1));
        await specs.create(specOf(SPEC_A_NEW, APP_A, "PROVIDER", [], "active", 2));
        await specs.create(specOf(SPEC_B, APP_B, "PROVIDER", [], "active", 1));
        await specs.create(
          specOf(
            SPEC_CONS,
            CONS_APP,
            "CONSUMER",
            [group("widgets", "getWidget", "name")],
            "active",
            1,
          ),
        );
        await specs.create(
          specOf(
            SPEC_BACK,
            BACK_APP,
            "PROVIDER",
            [group("things", "getThing", "name")],
            "active",
            1,
          ),
        );

        const mappings = new ApprovedMappingRepository(txn);
        const artifacts = new MappingArtifactsRepository(txn);
        const downstream = new DownstreamArtifactRepository(txn);

        // ── Peer-peer: stale predecessor (2 pairs) + a stale counterpart + the successor ──
        await mappings.insert({
          id: M_PRED,
          sourceSpecId: SPEC_A_OLD,
          targetSpecId: SPEC_B,
          sourceAppId: APP_A,
          targetAppId: APP_B,
          variant: "peer-peer",
          approvedBy: "operator",
          approvedAt: CREATED_AT,
          status: "stale",
        });
        await artifacts.replaceChildren(M_PRED, {
          fieldMappings: [
            peerField(M_PRED, "issues/title", "tasks/title"),
            peerField(M_PRED, "comments/body", "notes/text"),
          ],
          operationMappings: [],
          parameterMappings: [],
        });
        await mappings.insert({
          id: M_CP,
          sourceSpecId: SPEC_B,
          targetSpecId: SPEC_A_OLD,
          sourceAppId: APP_B,
          targetAppId: APP_A,
          variant: "peer-peer",
          approvedBy: "operator",
          approvedAt: CREATED_AT,
          status: "stale",
        });
        // Cross-link the peer pair now that both rows exist (avoids the circular FK).
        await mappings.setCounterpart(M_PRED, M_CP);
        await mappings.setCounterpart(M_CP, M_PRED);
        // The successor: pinned to the NEW source version, carrying predecessorMappingId, with
        // its child set already the UNION (re-reviewed issues↔tasks + carried-forward
        // comments↔notes), as the re-review approval produces (SL-7.6).
        await mappings.insert({
          id: M_SUCC,
          sourceSpecId: SPEC_A_NEW,
          targetSpecId: SPEC_B,
          sourceAppId: APP_A,
          targetAppId: APP_B,
          variant: "peer-peer",
          approvedBy: "reviewer-adopt",
          approvedAt: OBSERVED_AT,
          status: "active",
          predecessorMappingId: M_PRED,
        });
        await artifacts.replaceChildren(M_SUCC, {
          fieldMappings: [
            peerField(M_SUCC, "issues/title", "tasks/title"),
            peerField(M_SUCC, "comments/body", "notes/text"),
          ],
          operationMappings: [],
          parameterMappings: [],
        });

        // Two enabled rules with live operational state, on the predecessor.
        await downstream.insertSyncRuleIfAbsent(
          ruleOf({
            id: RULE_ISSUES,
            mappingId: M_PRED,
            resourcePairRef: ISSUES_PAIR,
            cursor: "cursor-issues",
            lastSnapshotRef: SNAPSHOT_ISSUES,
            pollOperationRef: "issues/listIssues",
          }),
        );
        await downstream.insertSyncRuleIfAbsent(
          ruleOf({
            id: RULE_COMMENTS,
            mappingId: M_PRED,
            resourcePairRef: COMMENTS_PAIR,
            cursor: "cursor-comments",
            lastSnapshotRef: null,
          }),
        );

        // A RecordLink + a SyncFieldState baseline on the issues pair — must stay untouched.
        const link: RecordLink = {
          id: LINK_ID,
          appAId: APP_A,
          appANativeId: "issue-1",
          appBId: APP_B,
          appBNativeId: "task-1",
          resourcePairRef: ISSUES_PAIR,
          establishedBy: "identity-match",
          status: "active",
          establishingQueueKey: { kind: "identity-value", value: "issue-1" },
          createdAt: CREATED_AT,
          tombstonedAt: null,
        };
        await new RecordLinkRepository(txn).insert(link);
        const fieldState: SyncFieldState = {
          id: randomUUID(),
          recordLinkId: LINK_ID,
          side: "A",
          fieldPath: "issues/title",
          observedHash: "hash-original",
          observedAt: OBSERVED_AT,
          observedChangeTimestamp: null,
          status: "active",
        };
        await new SyncFieldStateRepository(txn).seed([fieldState]);

        // ── Consumer-provider: stale predecessor + endpoint/binding + compatible successor ──
        await mappings.insert({
          id: MP_PRED,
          sourceSpecId: SPEC_CONS,
          targetSpecId: SPEC_BACK,
          sourceAppId: CONS_APP,
          targetAppId: BACK_APP,
          variant: "consumer-provider",
          approvedBy: "operator",
          approvedAt: CREATED_AT,
          status: "stale",
        });
        const predOp: OperationMapping = {
          id: randomUUID(),
          mappingId: MP_PRED,
          sourceOperationRef: "widgets/getWidget",
          targetOperationRef: "things/getThing",
          action: "read",
        };
        await artifacts.replaceChildren(MP_PRED, {
          fieldMappings: [
            {
              id: randomUUID(),
              mappingId: MP_PRED,
              sourcePath: "things/name",
              targetPath: "widgets/name",
              transform: "rename",
              phase: "response",
            },
          ],
          operationMappings: [predOp],
          parameterMappings: [],
        });
        await mappings.insert({
          id: MP_SUCC,
          sourceSpecId: SPEC_CONS,
          targetSpecId: SPEC_BACK,
          sourceAppId: CONS_APP,
          targetAppId: BACK_APP,
          variant: "consumer-provider",
          approvedBy: "reviewer-adopt",
          approvedAt: OBSERVED_AT,
          status: "active",
          predecessorMappingId: MP_PRED,
        });
        await artifacts.replaceChildren(MP_SUCC, {
          fieldMappings: [
            {
              id: randomUUID(),
              mappingId: MP_SUCC,
              sourcePath: "things/name",
              targetPath: "widgets/name",
              transform: "rename",
              phase: "response",
            },
          ],
          operationMappings: [
            {
              id: randomUUID(),
              mappingId: MP_SUCC,
              sourceOperationRef: "widgets/getWidget",
              targetOperationRef: "things/getThing",
              action: "read",
            },
          ],
          parameterMappings: [],
        });
        await txn.insert(adapterEndpoint).values(
          toAdapterEndpointInsert({
            id: ENDPOINT,
            consumerAppId: CONS_APP,
            consumerOperationId: "widgets/getWidget",
            status: "active",
            aggregationStrategy: "single",
            strictness: "degraded",
          }),
        );
        await txn.insert(adapterBinding).values(
          toAdapterBindingInsert({
            id: BINDING,
            adapterEndpointId: ENDPOINT,
            backendAppId: BACK_APP,
            backendOperationId: "things/getThing",
            approvedMappingId: MP_PRED,
            role: "primary",
            status: "active",
          }),
        );
      });

      // The REAL adoption wiring: a GraphProjection + AdapterCompositionService driving CO-7.
      const graphProjection = new GraphProjection({ db, newId: randomUUID });
      cacheSpy = new SpyEndpointInvalidator();
      const adapterComposition = new AdapterCompositionService({
        db,
        newId: randomUUID,
        graphProjection,
        cacheInvalidator: cacheSpy,
      });
      consumer = buildArtifactInstantiation({
        db,
        adoption: {
          graphProjection,
          adoptAdapter: async (input, actor) => {
            await adapterComposition.adoptSuccessor(input, actor);
          },
        },
      }).consumer;
    });

    afterAll(async () => {
      await cleanup(db);
      await db.$client.end();
    });

    function mappingApprovedEvent(
      approvedMappingId: string,
      variant: "peer-peer" | "consumer-provider",
    ): DeliveredEvent {
      return {
        id: randomUUID(),
        type: MAPPING_APPROVED_EVENT_TYPE,
        occurredAt: OBSERVED_AT,
        payload: { approvedMappingId, variant },
      };
    }

    it("adopts a peer-peer successor: re-points rules (state preserved), transfers counterpart, supersedes, records untouched", async () => {
      await tx(db, (txn) => consumer.handle(mappingApprovedEvent(M_SUCC, "peer-peer"), txn));

      // SL-7.1/8.1 — both rules re-pointed to the successor; every operational column preserved.
      const ruleRepo = new SyncRuleRepository(db);
      const issuesRule = await ruleRepo.getById(RULE_ISSUES);
      const commentsRule = await ruleRepo.getById(RULE_COMMENTS);
      expect(issuesRule?.approvedMappingId).toBe(M_SUCC);
      expect(commentsRule?.approvedMappingId).toBe(M_SUCC);
      expect(issuesRule?.cursor).toBe("cursor-issues");
      expect(issuesRule?.lastSnapshotRef).toBe(SNAPSHOT_ISSUES);
      expect(issuesRule?.backfillStatus).toBe("completed");
      expect(issuesRule?.status).toBe("enabled");
      expect(issuesRule?.pollOperationRef).toBe("issues/listIssues");
      expect(commentsRule?.cursor).toBe("cursor-comments");

      const mappingRepo = new ApprovedMappingRepository(db);
      // SL-7.1 — predecessor superseded.
      expect((await mappingRepo.getById(M_PRED))?.status).toBe("superseded");
      // SL-7.3 — counterpart pairing transferred to the successor, both directions.
      expect((await mappingRepo.getById(M_SUCC))?.counterpartMappingId).toBe(M_CP);
      expect((await mappingRepo.getById(M_CP))?.counterpartMappingId).toBe(M_SUCC);

      // SL-7.6 — the successor still covers BOTH resource pairs (issues + carried comments).
      const succFields = await new MappingArtifactsRepository(db).listFieldMappings(M_SUCC);
      expect(succFields.map((f) => f.sourcePath).sort()).toEqual(["comments/body", "issues/title"]);

      // SL-8.3 — RecordLink + SyncFieldState untouched as records.
      const link = await new RecordLinkRepository(db).getById(LINK_ID);
      expect(link?.status).toBe("active");
      expect(link?.appANativeId).toBe("issue-1");
      const states = await new SyncFieldStateRepository(db).findByLink(LINK_ID);
      expect(states).toHaveLength(1);
      expect(states[0]?.status).toBe("active");
      expect(states[0]?.observedHash).toBe("hash-original");

      // SL-7.7 — the sync GraphEdge for (A → B) exists (recomputed from the re-pointed rules).
      const edges = await db
        .select()
        .from(graphEdge)
        .where(
          and(
            eq(graphEdge.sourceNodeId, APP_A),
            eq(graphEdge.targetNodeId, APP_B),
            eq(graphEdge.type, "sync"),
          ),
        );
      expect(edges).toHaveLength(1);
    });

    it("drives CO-7 adoptSuccessor for a consumer-provider successor: re-points the binding in place, supersedes the predecessor", async () => {
      const cacheCallsBefore = cacheSpy.calls.length;
      await tx(db, (txn) =>
        consumer.handle(mappingApprovedEvent(MP_SUCC, "consumer-provider"), txn),
      );

      // SL-7.5 — the AdapterBinding re-pointed to the successor IN PLACE (same id).
      const [binding] = await db
        .select()
        .from(adapterBinding)
        .where(eq(adapterBinding.id, BINDING));
      expect(binding?.approvedMappingId).toBe(MP_SUCC);
      // A compatible successor keeps the endpoint serving (never a broken active).
      const [endpoint] = await db
        .select()
        .from(adapterEndpoint)
        .where(eq(adapterEndpoint.id, ENDPOINT));
      expect(["active", "composition-required"]).toContain(endpoint?.status);
      // SL-7.1 — predecessor superseded.
      expect((await new ApprovedMappingRepository(db).getById(MP_PRED))?.status).toBe("superseded");
      // CO-7.5 / CH-5.4 — the affected endpoint's cache was dropped through the shared seam.
      expect(cacheSpy.calls.slice(cacheCallsBefore)).toContain(ENDPOINT);
    });
  },
);
