import type { ApprovedMapping, FieldMapping } from "@mediator/domain";
import { MAPPING_APPROVED_EVENT_TYPE } from "@mediator/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { BadRequestError, NotFoundError } from "../../app-errors.js";
import { ApprovalService } from "./approval-service.js";
import { FakeApprovalPersistence } from "./approval.testkit.js";
import {
  consumerProviderFixture,
  peerPeerFixture,
  type ConsumerProviderFixture,
  type PeerPeerFixture,
} from "./fixtures.testkit.js";

const ACTOR = "operator@example.test";
const NOW = new Date("2026-07-12T09:00:00.000Z");

function makeService(fake: FakeApprovalPersistence): ApprovalService {
  let counter = 0;
  return new ApprovalService({
    unitOfWork: fake,
    newId: () => `gen-${String(++counter)}`,
    now: () => NOW,
  });
}

/** A peer-peer setup: specs + proposal + items seeded into a fresh fake. */
function setupPeerPeer(): {
  fake: FakeApprovalPersistence;
  service: ApprovalService;
  fx: PeerPeerFixture;
} {
  const fake = new FakeApprovalPersistence();
  const fx = peerPeerFixture();
  fake.seedSpec(fx.sourceSpec);
  fake.seedSpec(fx.targetSpec);
  fake.seedProposal(fx.proposal, fx.allItems);
  return { fake, service: makeService(fake), fx };
}

function setupConsumerProvider(): {
  fake: FakeApprovalPersistence;
  service: ApprovalService;
  fx: ConsumerProviderFixture;
} {
  const fake = new FakeApprovalPersistence();
  const fx = consumerProviderFixture();
  fake.seedSpec(fx.sourceSpec);
  fake.seedSpec(fx.targetSpec);
  fake.seedProposal(fx.proposal, fx.allItems);
  return { fake, service: makeService(fake), fx };
}

// ── AS-1: per-item decisions ─────────────────────────────────────────────────

describe("AS-1 per-item decisions", () => {
  let ctx: ReturnType<typeof setupPeerPeer>;
  beforeEach(() => {
    ctx = setupPeerPeer();
  });

  it("accepts a pending item and writes a mapping-decision audit entry", async () => {
    const updated = await ctx.service.decideItem(
      { itemId: ctx.fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    expect(updated.reviewState).toBe("accepted");
    expect(ctx.fake.items.get(ctx.fx.items.titleField.id)?.reviewState).toBe("accepted");

    expect(ctx.fake.auditEntries).toHaveLength(1);
    const entry = ctx.fake.auditEntries[0];
    expect(entry?.type).toBe("mapping-decision");
    expect(entry?.decision).toBe("accept");
    expect(entry?.actor).toBe(ACTOR);
    expect(entry?.relatedItemId).toBe(ctx.fx.items.titleField.id);
    expect(entry?.relatedProposalId).toBe(ctx.fx.proposal.id);
  });

  it("edits a field item's targetRef (picking an alternative) → edited", async () => {
    const updated = await ctx.service.decideItem(
      {
        itemId: ctx.fx.items.stateField.id,
        decision: {
          kind: "edit",
          edit: { targetRef: { resourceRef: "tasks", target: { kind: "field", path: "title" } } },
        },
      },
      ACTOR,
    );
    expect(updated.reviewState).toBe("edited");
    expect(updated.targetRef).toStrictEqual({
      resourceRef: "tasks",
      target: { kind: "field", path: "title" },
    });
    // The transform is preserved when only the target is edited.
    expect(updated.transformSuggestion).toStrictEqual({
      transform: "coerce",
      detail: "open→false, closed→true",
    });
    expect(ctx.fake.auditEntries[0]?.decision).toBe("edit");
  });

  it("maps an unmapped item when edited with a targetRef + transform", async () => {
    const updated = await ctx.service.decideItem(
      {
        itemId: ctx.fx.items.legacyField.id,
        decision: {
          kind: "edit",
          edit: {
            targetRef: { resourceRef: "tasks", target: { kind: "field", path: "title" } },
            transform: { transform: "rename" },
          },
        },
      },
      ACTOR,
    );
    expect(updated.reviewState).toBe("edited");
    expect(updated.unmapped).toBe(false);
    expect(updated.transformSuggestion).toStrictEqual({ transform: "rename" });
  });

  it("accepts an unmapped item as-is, leaving it unmapped", async () => {
    const updated = await ctx.service.decideItem(
      { itemId: ctx.fx.items.legacyField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    expect(updated.reviewState).toBe("accepted");
    expect(updated.unmapped).toBe(true);
    expect("targetRef" in updated).toBe(false);
  });

  it("rejects an item, and the rejection is permanent", async () => {
    await ctx.service.decideItem(
      { itemId: ctx.fx.items.titleField.id, decision: { kind: "reject" } },
      ACTOR,
    );
    expect(ctx.fake.items.get(ctx.fx.items.titleField.id)?.reviewState).toBe("rejected");

    // A further decision on a rejected item is refused (AS-1 criterion 3).
    await expect(
      ctx.service.decideItem(
        { itemId: ctx.fx.items.titleField.id, decision: { kind: "accept" } },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("refuses a transform on an operation edit", async () => {
    await expect(
      ctx.service.decideItem(
        {
          itemId: ctx.fx.items.listOp.id,
          decision: { kind: "edit", edit: { transform: { transform: "rename" } } },
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects a decision on an unknown item", async () => {
    await expect(
      ctx.service.decideItem({ itemId: "nope", decision: { kind: "accept" } }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── AS-2: partial approval + assembly ────────────────────────────────────────

describe("AS-2 partial approval assembles decided items", () => {
  it("assembles accepted/edited items and marks the proposal partially_approved", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.decideItem({ itemId: fx.items.updateOp.id, decision: { kind: "accept" } }, ACTOR);

    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    expect(result.outcome).toBe("partially_approved");
    expect(fake.proposals.get(fx.proposal.id)?.status).toBe("partially_approved");

    // Exactly one ApprovedMapping, status active, one-directional.
    expect(fake.approvedMappings.size).toBe(1);
    const mapping = [...fake.approvedMappings.values()][0];
    expect(mapping?.status).toBe("active");
    expect(mapping?.variant).toBe("peer-peer");
    expect(mapping?.approvedBy).toBe(ACTOR);
    expect(mapping?.sourceSpecId).toBe(fx.sourceSpec.id);
    expect(mapping?.targetSpecId).toBe(fx.targetSpec.id);

    // The accepted items became FieldMapping / OperationMapping children.
    expect(fake.fieldMappings.map((f) => f.sourcePath)).toStrictEqual(["issues/title"]);
    expect(fake.operationMappings.map((o) => o.sourceOperationRef)).toStrictEqual([
      "issues/updateIssue",
    ]);
  });

  it("marks the proposal approved when every item is decided with ≥1 accepted", async () => {
    const { fake, service, fx } = setupPeerPeer();
    // Decide EVERY item: accept the mapped ones, reject the unmapped one.
    for (const item of [
      fx.items.listOp,
      fx.items.createOp,
      fx.items.updateOp,
      fx.items.deleteOp,
      fx.items.titleField,
      fx.items.emailField,
      fx.items.stateField,
    ]) {
      await service.decideItem({ itemId: item.id, decision: { kind: "accept" } }, ACTOR);
    }
    await service.decideItem(
      { itemId: fx.items.legacyField.id, decision: { kind: "reject" } },
      ACTOR,
    );

    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    expect(result.outcome).toBe("approved");
    expect(fake.proposals.get(fx.proposal.id)?.status).toBe("approved");
  });

  it("marks the proposal rejected with no ApprovedMapping when every item is rejected", async () => {
    const { fake, service, fx } = setupPeerPeer();
    for (const item of fx.allItems) {
      await service.decideItem({ itemId: item.id, decision: { kind: "reject" } }, ACTOR);
    }
    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    expect(result.outcome).toBe("rejected");
    expect(fake.approvedMappings.size).toBe(0);
    expect(fake.events).toHaveLength(0);
    expect(fake.proposals.get(fx.proposal.id)?.status).toBe("rejected");
  });

  it("refuses an approve with nothing mapped but items still pending", async () => {
    const { service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.legacyField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await expect(service.approve({ proposalId: fx.proposal.id }, ACTOR)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("updates the SAME ApprovedMapping in place on a later incremental approve", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    const first = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    const firstId = first.outcome === "rejected" ? undefined : first.mapping.id;
    expect(firstId).toBeDefined();

    // A later approve adds more items.
    await service.decideItem(
      { itemId: fx.items.stateField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    const second = await service.approve({ proposalId: fx.proposal.id }, ACTOR);

    expect(fake.approvedMappings.size).toBe(1);
    if (second.outcome === "rejected") throw new Error("unexpected rejected");
    expect(second.mapping.id).toBe(firstId);
    // Both accepted fields are now present under the one mapping.
    expect(
      fake.fieldMappings
        .filter((f) => f.mappingId === firstId)
        .map((f) => f.sourcePath)
        .sort(),
    ).toStrictEqual(["issues/state", "issues/title"]);
  });

  it("assembles consumer-provider parameter mappings under their operation pairing", async () => {
    const { fake, service, fx } = setupConsumerProvider();
    for (const item of fx.allItems) {
      await service.decideItem({ itemId: item.id, decision: { kind: "accept" } }, ACTOR);
    }
    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    expect(result.outcome).toBe("approved");
    if (result.outcome === "rejected") throw new Error("unexpected");

    expect(result.mapping.variant).toBe("consumer-provider");
    // request/response FieldMappings keep their phase.
    const phases = fake.fieldMappings.map((f) => f.phase).sort();
    expect(phases).toStrictEqual(["request", "response"]);
    // One ParameterMapping, hung off the (only) OperationMapping.
    expect(fake.parameterMappings).toHaveLength(1);
    const op = fake.operationMappings[0];
    expect(fake.parameterMappings[0]?.operationMappingId).toBe(op?.id);
    expect(fake.parameterMappings[0]?.sourceParamRef).toBe("search/searchIssues#owner");
    expect(fake.parameterMappings[0]?.targetParamRef).toBe("list/listTasks#project");
  });

  it("creates no downstream artifact — only the mapping, its children, audit, and one event", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem({ itemId: fx.items.updateOp.id, decision: { kind: "accept" } }, ACTOR);
    await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    // The only emitted event is the single MappingApproved — no sync/adapter side effect.
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]?.type).toBe(MAPPING_APPROVED_EVENT_TYPE);
  });
});

// ── AS-3: edit-path validation is atomic ─────────────────────────────────────

describe("AS-3 edit-path validation before assembly", () => {
  it("rejects the whole approve when an edited field ref does not resolve, committing nothing", async () => {
    const { fake, service, fx } = setupPeerPeer();
    // Accept a valid item, then edit another to point at a non-existent target field.
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.decideItem(
      {
        itemId: fx.items.stateField.id,
        decision: {
          kind: "edit",
          edit: { targetRef: { resourceRef: "tasks", target: { kind: "field", path: "ghost" } } },
        },
      },
      ACTOR,
    );

    await expect(service.approve({ proposalId: fx.proposal.id }, ACTOR)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    // Atomic: nothing committed.
    expect(fake.approvedMappings.size).toBe(0);
    expect(fake.fieldMappings).toHaveLength(0);
    expect(fake.events).toHaveLength(0);
    expect(fake.proposals.get(fx.proposal.id)?.status).toBe("pending");
  });

  it("rejects an unresolvable edited operation ref", async () => {
    const { service, fx } = setupPeerPeer();
    await service.decideItem(
      {
        itemId: fx.items.updateOp.id,
        decision: {
          kind: "edit",
          edit: {
            targetRef: {
              resourceRef: "tasks",
              target: { kind: "operation", operationId: "ghostOp" },
            },
          },
        },
      },
      ACTOR,
    );
    await expect(service.approve({ proposalId: fx.proposal.id }, ACTOR)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("validates accepted-as-is items too (defense in depth)", async () => {
    // Seed a proposal whose item was generated against a since-diverged target.
    const fake = new FakeApprovalPersistence();
    const fx = peerPeerFixture();
    fake.seedSpec(fx.sourceSpec);
    fake.seedSpec(fx.targetSpec);
    const brokenItem = {
      ...fx.items.titleField,
      targetRef: { resourceRef: "tasks", target: { kind: "field" as const, path: "ghost" } },
    };
    fake.seedProposal(fx.proposal, [brokenItem]);
    const service = makeService(fake);

    await service.decideItem({ itemId: brokenItem.id, decision: { kind: "accept" } }, ACTOR);
    await expect(service.approve({ proposalId: fx.proposal.id }, ACTOR)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});

// ── AS-4: action classification + targetIdParamRef ───────────────────────────

describe("AS-4 action classification and targetIdParamRef", () => {
  async function approveAllOperations(): Promise<FakeApprovalPersistence> {
    const { fake, service, fx } = setupPeerPeer();
    for (const item of [fx.items.listOp, fx.items.createOp, fx.items.updateOp, fx.items.deleteOp]) {
      await service.decideItem({ itemId: item.id, decision: { kind: "accept" } }, ACTOR);
    }
    await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    return fake;
  }

  it("derives create/read/update/delete mechanically and never emits list", async () => {
    const fake = await approveAllOperations();
    const byRef = new Map(fake.operationMappings.map((o) => [o.sourceOperationRef, o]));
    expect(byRef.get("issues/listIssues")?.action).toBe("read");
    expect(byRef.get("issues/createIssue")?.action).toBe("create");
    expect(byRef.get("issues/updateIssue")?.action).toBe("update");
    expect(byRef.get("issues/deleteIssue")?.action).toBe("delete");
    expect(fake.operationMappings.every((o) => o.action !== ("list" as string))).toBe(true);
  });

  it("derives targetIdParamRef for peer-peer update/delete and omits it on create/read", async () => {
    const fake = await approveAllOperations();
    const byRef = new Map(fake.operationMappings.map((o) => [o.sourceOperationRef, o]));
    expect(byRef.get("issues/updateIssue")?.targetIdParamRef).toBe("tasks/updateTask#taskId");
    expect(byRef.get("issues/deleteIssue")?.targetIdParamRef).toBe("tasks/deleteTask#taskId");
    expect("targetIdParamRef" in (byRef.get("issues/createIssue") ?? {})).toBe(false);
    expect("targetIdParamRef" in (byRef.get("issues/listIssues") ?? {})).toBe(false);
  });

  it("honours a reviewer action override (update → delete), keeping the target-id parameter", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem({ itemId: fx.items.updateOp.id, decision: { kind: "accept" } }, ACTOR);
    await service.approve(
      {
        proposalId: fx.proposal.id,
        operationOverrides: [{ itemId: fx.items.updateOp.id, action: "delete" }],
      },
      ACTOR,
    );
    const op = fake.operationMappings[0];
    expect(op?.action).toBe("delete");
    expect(op?.targetIdParamRef).toBe("tasks/updateTask#taskId");
  });

  it("honours a reviewer targetIdParamRef correction", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem({ itemId: fx.items.updateOp.id, decision: { kind: "accept" } }, ACTOR);
    await service.approve(
      {
        proposalId: fx.proposal.id,
        operationOverrides: [{ itemId: fx.items.updateOp.id, targetIdParamName: "taskId" }],
      },
      ACTOR,
    );
    expect(fake.operationMappings[0]?.targetIdParamRef).toBe("tasks/updateTask#taskId");
  });

  it("rejects a targetIdParamRef correction naming a non-existent parameter", async () => {
    const { service, fx } = setupPeerPeer();
    await service.decideItem({ itemId: fx.items.updateOp.id, decision: { kind: "accept" } }, ACTOR);
    await expect(
      service.approve(
        {
          proposalId: fx.proposal.id,
          operationOverrides: [{ itemId: fx.items.updateOp.id, targetIdParamName: "ghostParam" }],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("carries no targetIdParamRef on a consumer-provider operation", async () => {
    const { fake, service, fx } = setupConsumerProvider();
    await service.decideItem({ itemId: fx.items.searchOp.id, decision: { kind: "accept" } }, ACTOR);
    await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    expect("targetIdParamRef" in (fake.operationMappings[0] ?? {})).toBe(false);
    expect(fake.operationMappings[0]?.action).toBe("read");
  });
});

// ── AS-5: identity-key confirmation ──────────────────────────────────────────

describe("AS-5 identity-key confirmation", () => {
  function identityField(fake: FakeApprovalPersistence): FieldMapping | undefined {
    return fake.fieldMappings.find((f) => f.isIdentityKey === true);
  }

  it("sets isIdentityKey ONLY on explicit confirmation, storing targetLookupParamRef", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.emailField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.approve(
      {
        proposalId: fx.proposal.id,
        identityKeys: [{ itemId: fx.items.emailField.id, targetLookupParamRef: "email" }],
      },
      ACTOR,
    );
    const id = identityField(fake);
    expect(id?.sourcePath).toBe("issues/email");
    expect(id?.isIdentityKey).toBe(true);
    expect(id?.targetLookupParamRef).toBe("email");
  });

  it("never auto-confirms from identityCandidate", async () => {
    const { fake, service, fx } = setupPeerPeer();
    // emailField.identityCandidate === true, but no confirmation is passed.
    await service.decideItem(
      { itemId: fx.items.emailField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    expect(identityField(fake)).toBeUndefined();
    // Approval still completes — a mapping without a confirmed identity key is valid.
    expect(fake.approvedMappings.size).toBe(1);
  });

  it("records targetLookupParamRef absence when the reviewer confirms without one", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.emailField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.approve(
      { proposalId: fx.proposal.id, identityKeys: [{ itemId: fx.items.emailField.id }] },
      ACTOR,
    );
    const id = identityField(fake);
    expect(id?.isIdentityKey).toBe(true);
    expect("targetLookupParamRef" in (id ?? {})).toBe(false);
  });

  it("rejects an identity key on a non-rename field (rename-only)", async () => {
    const { service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.stateField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await expect(
      service.approve(
        { proposalId: fx.proposal.id, identityKeys: [{ itemId: fx.items.stateField.id }] },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects two identity keys for the same resource pair (one per pair)", async () => {
    const { service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.emailField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await expect(
      service.approve(
        {
          proposalId: fx.proposal.id,
          identityKeys: [{ itemId: fx.items.emailField.id }, { itemId: fx.items.titleField.id }],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects an identity-key step on a consumer-provider proposal", async () => {
    const { service, fx } = setupConsumerProvider();
    await service.decideItem(
      { itemId: fx.items.requestField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await expect(
      service.approve(
        { proposalId: fx.proposal.id, identityKeys: [{ itemId: fx.items.requestField.id }] },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  describe("shared-pairing lock", () => {
    /** Seed a reverse-direction (tasks → issues) mapping with a confirmed identity pairing. */
    function seedReverseIdentity(
      fake: FakeApprovalPersistence,
      fx: PeerPeerFixture,
      targetPath: string,
    ): void {
      const reverse: ApprovedMapping = {
        id: "reverse-mapping",
        sourceSpecId: fx.targetSpec.id,
        targetSpecId: fx.sourceSpec.id,
        sourceAppId: fx.appBId,
        targetAppId: fx.appAId,
        variant: "peer-peer",
        approvedBy: ACTOR,
        approvedAt: NOW,
        status: "active",
      };
      const idField: FieldMapping = {
        id: "reverse-id-field",
        mappingId: "reverse-mapping",
        sourcePath: "tasks/email",
        targetPath,
        transform: "rename",
        isIdentityKey: true,
      };
      fake.seedApprovedMapping(reverse, { fieldMappings: [idField] });
    }

    it("accepts the SAME field pairing the counterpart confirmed", async () => {
      const { fake, service, fx } = setupPeerPeer();
      seedReverseIdentity(fake, fx, "issues/email");
      await service.decideItem(
        { itemId: fx.items.emailField.id, decision: { kind: "accept" } },
        ACTOR,
      );
      const result = await service.approve(
        { proposalId: fx.proposal.id, identityKeys: [{ itemId: fx.items.emailField.id }] },
        ACTOR,
      );
      expect(result.outcome).toBe("partially_approved");
    });

    it("rejects a DIFFERENT field pairing than the counterpart confirmed", async () => {
      const { fake, service, fx } = setupPeerPeer();
      // Counterpart identity pairs tasks/email → issues/legacyCode (a different A-side field).
      seedReverseIdentity(fake, fx, "issues/legacyCode");
      await service.decideItem(
        { itemId: fx.items.emailField.id, decision: { kind: "accept" } },
        ACTOR,
      );
      await expect(
        service.approve(
          { proposalId: fx.proposal.id, identityKeys: [{ itemId: fx.items.emailField.id }] },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects re-confirming an edited identity that diverges from the counterpart", async () => {
      const { fake, service, fx } = setupPeerPeer();
      // Counterpart confirmed the tasks/email ↔ issues/email pairing.
      seedReverseIdentity(fake, fx, "issues/email");
      // The operator edits the identity field's target to tasks/title, then RE-CONFIRMS
      // it — a pairing that no longer matches the counterpart. The lock rejects it.
      await service.decideItem(
        {
          itemId: fx.items.emailField.id,
          decision: {
            kind: "edit",
            edit: { targetRef: { resourceRef: "tasks", target: { kind: "field", path: "title" } } },
          },
        },
        ACTOR,
      );
      await expect(
        service.approve(
          { proposalId: fx.proposal.id, identityKeys: [{ itemId: fx.items.emailField.id }] },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  it("carries a confirmed identity key forward across an incremental approve", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.emailField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.approve(
      {
        proposalId: fx.proposal.id,
        identityKeys: [{ itemId: fx.items.emailField.id, targetLookupParamRef: "email" }],
      },
      ACTOR,
    );
    // A later approve adds another field WITHOUT re-confirming the identity key.
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.approve({ proposalId: fx.proposal.id }, ACTOR);

    const id = fake.fieldMappings.find((f) => f.isIdentityKey === true);
    expect(id?.sourcePath).toBe("issues/email");
    expect(id?.targetLookupParamRef).toBe("email");
  });

  it("drops a carried-forward identity key when its target was edited (no silent re-pairing)", async () => {
    const { fake, service, fx } = setupPeerPeer();
    // Approve #1 confirms issues/email → tasks/email as the identity key.
    await service.decideItem(
      { itemId: fx.items.emailField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    await service.approve(
      {
        proposalId: fx.proposal.id,
        identityKeys: [{ itemId: fx.items.emailField.id, targetLookupParamRef: "email" }],
      },
      ACTOR,
    );
    expect(fake.fieldMappings.find((f) => f.isIdentityKey === true)?.targetPath).toBe(
      "tasks/email",
    );

    // Edit the identity field's TARGET (transform stays rename), then approve again
    // WITHOUT re-confirming — the carry-forward must NOT silently re-pair the key.
    await service.decideItem(
      {
        itemId: fx.items.emailField.id,
        decision: {
          kind: "edit",
          edit: { targetRef: { resourceRef: "tasks", target: { kind: "field", path: "title" } } },
        },
      },
      ACTOR,
    );
    await service.approve({ proposalId: fx.proposal.id }, ACTOR);

    // The re-paired field carries NO identity key — an explicit re-confirmation is
    // required (which would re-run the AS-5 locks).
    expect(fake.fieldMappings.find((f) => f.isIdentityKey === true)).toBeUndefined();
    const email = fake.fieldMappings.find((f) => f.sourcePath === "issues/email");
    expect(email?.targetPath).toBe("tasks/title");
    expect("isIdentityKey" in (email ?? {})).toBe(false);
  });
});

// ── AS-6: emit + counterpart linking ─────────────────────────────────────────

describe("AS-6 emit and counterpart linking", () => {
  it("emits exactly one MappingApproved carrying the mapping id + variant", async () => {
    const { fake, service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    if (result.outcome === "rejected") throw new Error("unexpected");

    expect(fake.events).toHaveLength(1);
    expect(result.event.type).toBe(MAPPING_APPROVED_EVENT_TYPE);
    expect(result.event.approvedMappingId).toBe(result.mapping.id);
    expect(result.event.variant).toBe("peer-peer");
  });

  it("cross-links the counterpart when the reverse direction is already approved", async () => {
    const { fake, service, fx } = setupPeerPeer();
    const reverse: ApprovedMapping = {
      id: "reverse-mapping",
      sourceSpecId: fx.targetSpec.id,
      targetSpecId: fx.sourceSpec.id,
      sourceAppId: fx.appBId,
      targetAppId: fx.appAId,
      variant: "peer-peer",
      approvedBy: ACTOR,
      approvedAt: NOW,
      status: "active",
    };
    fake.seedApprovedMapping(reverse);

    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    if (result.outcome === "rejected") throw new Error("unexpected");

    expect(result.mapping.counterpartMappingId).toBe("reverse-mapping");
    expect(fake.approvedMappings.get("reverse-mapping")?.counterpartMappingId).toBe(
      result.mapping.id,
    );
  });

  it("leaves the mapping one-way when the reverse direction is not approved", async () => {
    const { service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    if (result.outcome === "rejected") throw new Error("unexpected");
    expect("counterpartMappingId" in result.mapping).toBe(false);
  });
});

// ── SL-6.4: approving a re-review proposal yields the stale mapping's successor ─────
describe("SL-6 successor link (predecessorMappingId)", () => {
  const STALE_ID = "stale-predecessor-1";

  /** A peer-peer re-review proposal (`reReviewOf` set) plus its retained stale predecessor. */
  function setupReReview(): {
    fake: FakeApprovalPersistence;
    service: ApprovalService;
    fx: PeerPeerFixture;
  } {
    const fake = new FakeApprovalPersistence();
    const fx = peerPeerFixture();
    fake.seedSpec(fx.sourceSpec);
    fake.seedSpec(fx.targetSpec);
    // The proposal is the successor re-review of a stale predecessor mapping (SL-6).
    fake.seedProposal({ ...fx.proposal, reReviewOf: STALE_ID }, fx.allItems);
    // The stale predecessor: a distinct, retained row pinned to its (superseded) prior version.
    const stalePredecessor: ApprovedMapping = {
      id: STALE_ID,
      sourceSpecId: "old-source-spec",
      targetSpecId: fx.targetSpec.id,
      sourceAppId: fx.appAId,
      targetAppId: fx.appBId,
      variant: "peer-peer",
      approvedBy: "reviewer:previous",
      approvedAt: NOW,
      status: "stale",
    };
    fake.seedApprovedMapping(stalePredecessor);
    return { fake, service: makeService(fake), fx };
  }

  it("stamps the fresh successor's predecessorMappingId from the proposal's reReviewOf (SL-6.4)", async () => {
    const { fake, service, fx } = setupReReview();
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );

    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    if (result.outcome === "rejected") throw new Error("unexpected rejected");

    // A distinct NEW successor row (not the retained stale predecessor), pinned to the
    // proposal's (new-version) spec pair, linked to its predecessor for SL-7 to adopt.
    expect(result.mapping.id).not.toBe(STALE_ID);
    expect(result.mapping.status).toBe("active");
    expect(result.mapping.predecessorMappingId).toBe(STALE_ID);
    expect(result.mapping.sourceSpecId).toBe(fx.sourceSpec.id);
    expect(result.mapping.targetSpecId).toBe(fx.targetSpec.id);

    // The stale predecessor is retained, untouched — two rows now coexist for audit.
    expect(fake.approvedMappings.get(STALE_ID)?.status).toBe("stale");
    expect(fake.approvedMappings.size).toBe(2);

    // SL-7 finds "the successor of this stale mapping" by the predecessor link (either way).
    const successor = [...fake.approvedMappings.values()].find(
      (mapping) => mapping.predecessorMappingId === STALE_ID,
    );
    expect(successor?.id).toBe(result.mapping.id);
  });

  it("stamps the successor once and carries it through an incremental second approve (SL-6.4)", async () => {
    const { fake, service, fx } = setupReReview();
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    const first = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    if (first.outcome === "rejected") throw new Error("unexpected rejected");

    // A later incremental approve updates the SAME successor in place — the link persists.
    await service.decideItem(
      { itemId: fx.items.stateField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    const second = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    if (second.outcome === "rejected") throw new Error("unexpected rejected");

    expect(second.mapping.id).toBe(first.mapping.id);
    expect(fake.approvedMappings.get(first.mapping.id)?.predecessorMappingId).toBe(STALE_ID);
    // Still exactly the successor + the retained stale predecessor.
    expect(fake.approvedMappings.size).toBe(2);
  });

  it("leaves an ordinary (non-re-review) approval's mapping with no predecessor link", async () => {
    const { service, fx } = setupPeerPeer();
    await service.decideItem(
      { itemId: fx.items.titleField.id, decision: { kind: "accept" } },
      ACTOR,
    );
    const result = await service.approve({ proposalId: fx.proposal.id }, ACTOR);
    if (result.outcome === "rejected") throw new Error("unexpected rejected");

    // The absent link stays absent (NULL → absent key, like counterpartMappingId).
    expect(result.mapping.predecessorMappingId).toBeUndefined();
    expect("predecessorMappingId" in result.mapping).toBe(false);
  });
});
