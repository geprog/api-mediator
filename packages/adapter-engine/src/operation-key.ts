import type { Ir } from "@mediator/domain";

/**
 * **The protocol-neutral operation key** — the stable identity of a consumer
 * operation across the adapter surface, `resourceRef/operationId`.
 *
 * This MUST equal the string Phase-3 stored on `AdapterEndpoint.consumerOperationId`
 * (the approval module's `serializeRef` for an operation ref, see
 * `apps/backend/src/modules/approval/refs.ts`): the endpoint is looked up by
 * `(consumerAppId, consumerOperationId)`, so a mounted operation and its endpoint
 * agree only if the same serialization is used on both sides. It is intentionally
 * **not** the OpenAPI `operationId` alone — that is not unique across a document
 * (SI-1 criterion 8) — nor the HTTP method/path, which are REST specifics that
 * live behind the Protocol Server seam and never reach this key.
 */
export function operationKey(resourceRef: string, operationId: string): string {
  return `${resourceRef}/${operationId}`;
}

/**
 * One routable operation of a mounted consumer surface, in **protocol-neutral**
 * terms: its {@link operationKey} plus the resource/operation it was derived from.
 * Deliberately carries no HTTP method or path — those are realized by the REST
 * Protocol Server behind the seam ([extensibility.md](../../../docs/architecture/extensibility.md)
 * *Beyond REST/OpenAPI*), not by this core.
 */
export interface MountedOperation {
  readonly operationKey: string;
  readonly resourceRef: string;
  readonly operationId: string;
}

/**
 * Derive the full set of mountable operations of a consumer spec from its
 * {@link Ir} — RT-2.1's "hosts the full consumer spec surface, derived from the
 * spec's IR, with no hand-written route table". Every operation of every resource
 * group is enumerated; the mount does not narrow the surface to a subset.
 *
 * This reads only the IR's protocol-neutral identifiers (`resourceRef`,
 * `operationId`) — never an operation's HTTP `method`/`path`, which the REST
 * Protocol Server interprets on its side of the seam. That is what keeps this core
 * free of OpenAPI/REST specifics while still owning the single definition of an
 * operation's key.
 */
export function deriveMountedOperations(ir: Ir): readonly MountedOperation[] {
  const operations: MountedOperation[] = [];
  for (const group of ir) {
    for (const operation of group.operations) {
      operations.push({
        operationKey: operationKey(group.resourceRef, operation.operationId),
        resourceRef: group.resourceRef,
        operationId: operation.operationId,
      });
    }
  }
  return operations;
}
