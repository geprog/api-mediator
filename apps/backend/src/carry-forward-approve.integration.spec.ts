import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  MappingArtifactsRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  eventOutbox,
  mappingProposal,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  tx,
  type Database,
} from "@mediator/db";
import { PostgresEventBus } from "@mediator/event-bus";
import type {
  ApiSpec,
  ApprovedMapping,
  Ir,
  MappingProposal,
  MappingProposalItem,
  RegisteredApp,
} from "@mediator/domain";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApprovalService } from "./modules/approval/approval-service.js";
import { DbApprovalUnitOfWork } from "./modules/approval/persistence.js";

/**
 * **SL-7.6 / SL-6.6 — live-Postgres integration for the carry-forward union produced by the
 * REAL `ApprovalService.approve()` on a re-review proposal.** It exercises the actual approval
 * wiring (not a pre-computed union), proving the successor's persisted child set is:
 *   - its own re-reviewed content for a TOUCHED pair the reviewer approved (`issues↔tasks`);
 *   - PLUS the predecessor's fields for an UNTOUCHED pair (`labels↔tags`), carried forward;
 *   - but NOT the predecessor's fields for a pair the re-review TOUCHED yet approved ZERO items
 *     for (`comments↔notes`) — coverage comes from SL-6's affected-pairs list (the proposal's
 *     `shortlistResult.candidatePairs`), so a touched-but-empty pair is treated genuinely dropped
 *     rather than resurrected.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`. Self-skips when unresolvable. Run in isolation (the shared-DB integration suite
 * is flaky across files); its teardown deletes everything it writes, FK-safe.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-23T00:00:00.000Z");
const ACTOR = "reviewer@example.test";

const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A_OLD = randomUUID();
const SPEC_A_NEW = randomUUID();
const SPEC_B = randomUUID();
const M_PRED = randomUUID();
const PROPOSAL_ID = randomUUID();
const ITEM_ISSUES = randomUUID();
const ITEM_COMMENTS = randomUUID();

const ALL_APP_IDS = [APP_A, APP_B];
const ALL_SPEC_IDS = [SPEC_A_OLD, SPEC_A_NEW, SPEC_B];

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: "https://cf-approve.example.test",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: CREATED_AT,
  };
}

// The target IR (App B) must resolve the ONE accepted item's target ref (`tasks/title`); the
// rejected item's ref and the carried-forward predecessor refs are never validated here.
const TARGET_IR: Ir = [
  {
    resourceRef: "tasks",
    name: "Tasks",
    operations: [{ operationId: "listTasks", method: "get", path: "/tasks", parameters: [] }],
    schemas: [
      {
        name: "Task",
        fields: [
          { name: "title", type: "string", required: false },
          { name: "name", type: "string", required: false },
        ],
      },
    ],
    crossResourceRefs: [],
  },
];

function specOf(
  id: string,
  appId: string,
  status: ApiSpec["status"],
  version: number,
  ir: Ir,
): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: ir,
    analysisExclusions: [],
    version,
    contentHash: `sha256:${id}`,
    status,
    createdAt: CREATED_AT,
  };
}

function fieldItem(
  id: string,
  input: {
    sourceResource: string;
    sourceField: string;
    targetResource: string;
    targetField: string;
    reviewState: MappingProposalItem["reviewState"];
  },
): MappingProposalItem {
  return {
    id,
    proposalId: PROPOSAL_ID,
    kind: "field",
    sourceRef: {
      resourceRef: input.sourceResource,
      target: { kind: "field", path: input.sourceField },
    },
    targetRef: {
      resourceRef: input.targetResource,
      target: { kind: "field", path: input.targetField },
    },
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.9,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: `${input.sourceField} → ${input.targetField}`,
    reviewState: input.reviewState,
  };
}

suite(
  "Phase-6 carry-forward union via the real ApprovalService.approve() (requires Postgres)",
  () => {
    let db: Database;
    let service: ApprovalService;
    let successorId: string | undefined;

    beforeAll(async () => {
      db = createDb(databaseUrl ?? "");
      await runMigrations(db);

      await tx(db, async (txn) => {
        const apps = new RegisteredAppRepository(txn);
        await apps.create(appOf(APP_A, `cf-a ${randomUUID()}`));
        await apps.create(appOf(APP_B, `cf-b ${randomUUID()}`));

        const specs = new ApiSpecRepository(txn);
        await specs.create(specOf(SPEC_A_OLD, APP_A, "superseded", 1, []));
        await specs.create(specOf(SPEC_A_NEW, APP_A, "active", 2, []));
        await specs.create(specOf(SPEC_B, APP_B, "active", 1, TARGET_IR));

        // The stale predecessor (A v1 → B) covering THREE resource pairs.
        const predecessor: ApprovedMapping = {
          id: M_PRED,
          sourceSpecId: SPEC_A_OLD,
          targetSpecId: SPEC_B,
          sourceAppId: APP_A,
          targetAppId: APP_B,
          variant: "peer-peer",
          approvedBy: "operator",
          approvedAt: CREATED_AT,
          status: "stale",
        };
        await new ApprovedMappingRepository(txn).insert(predecessor);
        await new MappingArtifactsRepository(txn).replaceChildren(M_PRED, {
          fieldMappings: [
            // issues↔tasks — TOUCHED + approved (the re-review retargets tasks/name → tasks/title).
            {
              id: randomUUID(),
              mappingId: M_PRED,
              sourcePath: "issues/title",
              targetPath: "tasks/name",
              transform: "rename",
            },
            // comments↔notes — TOUCHED but the reviewer approves ZERO items.
            {
              id: randomUUID(),
              mappingId: M_PRED,
              sourcePath: "comments/body",
              targetPath: "notes/text",
              transform: "rename",
            },
            // labels↔tags — UNTOUCHED → carried forward whole.
            {
              id: randomUUID(),
              mappingId: M_PRED,
              sourcePath: "labels/x",
              targetPath: "tags/y",
              transform: "rename",
            },
          ],
          operationMappings: [],
          parameterMappings: [],
        });

        // The re-review proposal (A v2 → B): reReviewOf = the stale predecessor, and its persisted
        // affected pairs (candidatePairs) are the two the break TOUCHED — issues↔tasks AND
        // comments↔notes. labels↔tags is NOT affected.
        const proposal: MappingProposal = {
          id: PROPOSAL_ID,
          sourceSpecId: SPEC_A_NEW,
          targetSpecId: SPEC_B,
          generatedBy: { providerId: "fixture", model: "fixture", promptVersion: "v1" },
          shortlistResult: {
            candidatePairs: [
              {
                sourceResource: "issues",
                targetResource: "tasks",
                confidence: 1,
                rationale: "touched",
                analysisFailed: false,
              },
              {
                sourceResource: "comments",
                targetResource: "notes",
                confidence: 1,
                rationale: "touched",
                analysisFailed: false,
              },
            ],
            noCounterpartResources: [],
          },
          status: "pending",
          createdAt: CREATED_AT,
          reReviewOf: M_PRED,
        };
        await new MappingProposalRepository(txn).create(proposal, [
          // Accepted: the re-reviewed issues↔tasks field (retargeted to tasks/title).
          fieldItem(ITEM_ISSUES, {
            sourceResource: "issues",
            sourceField: "title",
            targetResource: "tasks",
            targetField: "title",
            reviewState: "accepted",
          }),
          // Rejected: comments↔notes — a TOUCHED pair with zero approved items.
          fieldItem(ITEM_COMMENTS, {
            sourceResource: "comments",
            sourceField: "body",
            targetResource: "notes",
            targetField: "text",
            reviewState: "rejected",
          }),
        ]);
      });

      service = new ApprovalService({
        unitOfWork: new DbApprovalUnitOfWork(db, new PostgresEventBus()),
      });
    });

    afterAll(async () => {
      if (successorId !== undefined) {
        await db
          .delete(eventOutbox)
          .where(
            sql`${eventOutbox.type} = 'MappingApproved' AND ${eventOutbox.payload}->>'approvedMappingId' = ${successorId}`,
          );
        await db.delete(auditLog).where(eq(auditLog.relatedMappingId, successorId));
      }
      await db.delete(auditLog).where(eq(auditLog.relatedProposalId, PROPOSAL_ID));
      await db.delete(mappingProposal).where(eq(mappingProposal.id, PROPOSAL_ID));
      // predecessor + successor deleted in one statement (self-FK is NO ACTION); children cascade.
      await db.delete(approvedMapping).where(inArray(approvedMapping.sourceAppId, ALL_APP_IDS));
      await db.delete(apiSpec).where(inArray(apiSpec.id, ALL_SPEC_IDS));
      await db.delete(registeredApp).where(inArray(registeredApp.id, ALL_APP_IDS));
      await closeDb(db);
    });

    it("persists the carry-forward union: re-reviewed touched pair + carried untouched pair, NOT the touched-but-empty pair", async () => {
      const result = await service.approve({ proposalId: PROPOSAL_ID }, ACTOR);
      if (result.outcome === "rejected") {
        throw new Error("expected the accepted issues item to produce a successor");
      }
      successorId = result.mapping.id;

      // A fresh successor pinned to the new version, linked to its predecessor (SL-6.4).
      expect(result.mapping.sourceSpecId).toBe(SPEC_A_NEW);
      expect(result.mapping.predecessorMappingId).toBe(M_PRED);

      const successorFields = await new MappingArtifactsRepository(db).listFieldMappings(
        successorId,
      );
      const bySourcePath = successorFields.map((f) => f.sourcePath).sort();

      // The successor covers the re-reviewed issues↔tasks (retargeted) + the carried labels↔tags —
      // and NOT comments↔notes (touched-but-empty → covered by the affected-pairs list → dropped).
      expect(bySourcePath).toEqual(["issues/title", "labels/x"]);
      expect(successorFields.some((f) => f.sourcePath === "comments/body")).toBe(false);

      // The re-reviewed issues field carries its NEW target (tasks/title, not the predecessor's
      // tasks/name); the labels field carries forward the predecessor's exact pairing.
      expect(successorFields.find((f) => f.sourcePath === "issues/title")?.targetPath).toBe(
        "tasks/title",
      );
      const carried = successorFields.find((f) => f.sourcePath === "labels/x");
      expect(carried?.targetPath).toBe("tags/y");
      expect(carried?.mappingId).toBe(successorId);
    });
  },
);
