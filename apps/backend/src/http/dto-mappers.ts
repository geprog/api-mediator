import {
  RESOURCE_BINDING_REF_KINDS,
  type ApiSpecMetadataDto,
  type GraphEdgeDto,
  type RegisteredAppDto,
  type ResourceBindingDto,
  type ResourceBindingScopeDto,
  type ResourceGroupSummary,
} from "@mediator/contracts";
import type {
  ApiSpec,
  AppCapabilities,
  GraphEdge,
  Ir,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";

import { refApplicable } from "../modules/resource-bindings.js";
import type { ScopeLinkAuthoringContext } from "../modules/scope-authoring.js";

/**
 * Domain entity → wire DTO mappers. The one place `Date`s become ISO strings and
 * where response shapes are built **explicitly** — never by spreading a domain
 * entity — so `rawDocument`, `parsedIR`, and any credential material can never
 * leak into a metadata/list response (AR-2 crit 3/5, CR-2).
 */

/** `RegisteredApp` → wire DTO (AR-1/AR-2). `baseUrl` stays absent when absent. */
export function toRegisteredAppDto(app: RegisteredApp): RegisteredAppDto {
  return {
    id: app.id,
    name: app.name,
    status: app.status,
    capabilities: app.capabilities,
    createdAt: app.createdAt.toISOString(),
    ...(app.baseUrl !== undefined ? { baseUrl: app.baseUrl } : {}),
  };
}

/**
 * `GraphEdge` → wire DTO (GR-5.3): full `type`/`status`/`metadata` so the UI needs no
 * second call for edge detail. `metadata.lastActivityAt` (a domain `Date | null`) becomes
 * an ISO string or stays `null` (GR-4.3, an edge whose rules/bindings never executed).
 */
export function toGraphEdgeDto(edge: GraphEdge): GraphEdgeDto {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    type: edge.type,
    status: edge.status,
    metadata: {
      direction: {
        sourceSpecId: edge.metadata.direction.sourceSpecId,
        targetSpecId: edge.metadata.direction.targetSpecId,
      },
      lastActivityAt:
        edge.metadata.lastActivityAt === null ? null : edge.metadata.lastActivityAt.toISOString(),
    },
  };
}

/** `ApiSpec` → metadata DTO (AR-2 crit 2) — no `rawDocument`, no `parsedIR`. */
export function toApiSpecMetadataDto(spec: ApiSpec): ApiSpecMetadataDto {
  return {
    id: spec.id,
    appId: spec.appId,
    role: spec.role,
    version: spec.version,
    contentHash: spec.contentHash,
    status: spec.status,
    analysisExclusions: spec.analysisExclusions,
    createdAt: spec.createdAt.toISOString(),
  };
}

/**
 * `ResourceBinding` → wire DTO (RB-2/RB-3, SS-3): every ref kind is listed with
 * its value, confirmation state, and `applicable` flag (computed from the owning
 * app's `capabilities`), so a caller can tell not-applicable / unconfirmed /
 * confirmed apart in one pass; and every scope path-parameter binding is listed
 * with its `parameterName`, fill-source `kind`, and confirmed/unconfirmed state plus
 * the per-kind datum (`constant`'s literal `value` — SS-3 criterion 6; a
 * `record-derived`'s `sourceScopeKey` + optional `transform` — SS-8 criterion 1). The
 * scope `value` is operator config (shown as entered), never credential/live payload.
 * Built explicitly (never spread from the domain entity), so nothing beyond these
 * fields leaks.
 *
 * `scopeLink` carries the SS-18.4 kind-selector context, resolved by the
 * {@link ScopeLinkAuthoringResolver}: it is passed in rather than looked up here because
 * this mapper is pure and synchronous, while the context needs repository reads.
 */
export function toResourceBindingDto(
  binding: ResourceBinding,
  capabilities: AppCapabilities,
  scopeLink: ScopeLinkAuthoringContext,
): ResourceBindingDto {
  const refs = RESOURCE_BINDING_REF_KINDS.map((kind) => {
    const ref = binding[kind];
    const confirmedAt = ref?.confirmedAt ?? null;
    return {
      kind,
      applicable: refApplicable(kind, capabilities),
      value: ref?.value ?? null,
      confirmedBy: ref?.confirmedBy ?? null,
      confirmedAt: confirmedAt !== null ? confirmedAt.toISOString() : null,
    };
  });
  const scopeBindings = (binding.scopePathBindings ?? []).flatMap(
    (entry): ResourceBindingScopeDto[] => {
      const confirmedAt = entry.confirmedAt !== null ? entry.confirmedAt.toISOString() : null;
      // A kind-tagged discriminated DTO (SS-9): `record-derived` (SS-8) reports its
      // `sourceScopeKey` (+ any value-preserving `transform`) and carries **no** constant
      // literal; `constant` (SS-3) reports its operator-authored literal `value`. Built
      // explicitly per member so a record-derived entry never leaks a misleading `value`.
      if (entry.kind === "record-derived") {
        return [
          {
            parameterName: entry.parameterName,
            kind: "record-derived",
            sourceScopeKey: entry.sourceScopeKey,
            ...(entry.transform !== undefined ? { transform: entry.transform } : {}),
            confirmedBy: entry.confirmedBy,
            confirmedAt,
          },
        ];
      }
      if (entry.kind === "constant") {
        return [
          {
            parameterName: entry.parameterName,
            kind: "constant",
            value: entry.value,
            confirmedBy: entry.confirmedBy,
            confirmedAt,
          },
        ];
      }
      // `scope-link` (SS-12): report its `scopeKeyRef` (which target-container key of the
      // record's resolved `ScopeLink` fills this parameter) — no literal, no transform (the
      // value-space bridge is the `ScopeLink`). SS-12 is the first slice to persist a
      // `scope-link` binding, so serializing it keeps the bindings GET lossless; the
      // container-linking screen that renders it is SS-15.
      return [
        {
          parameterName: entry.parameterName,
          kind: "scope-link",
          scopeKeyRef: entry.scopeKeyRef,
          confirmedBy: entry.confirmedBy,
          confirmedAt,
        },
      ];
    },
  );
  // `sourceScopeRef` (SS-7): null when absent (no container field), else the
  // component set + its single confirmed/unconfirmed state (SS-9's UI consumes it).
  const source = binding.sourceScopeRef;
  const sourceScopeRef =
    source === undefined
      ? null
      : {
          components: source.components.map((component) => ({
            key: component.key,
            fieldPath: component.fieldPath,
          })),
          confirmedBy: source.confirmedBy,
          confirmedAt: source.confirmedAt !== null ? source.confirmedAt.toISOString() : null,
        };
  return {
    id: binding.id,
    apiSpecId: binding.apiSpecId,
    resourceRef: binding.resourceRef,
    refs,
    scopeBindings,
    sourceScopeRef,
    // SS-18.4 — the kind-selector context: whether this resource's pair has a proposed
    // `ScopeCorrespondence` (so `scope-link` is selectable) and, per scope parameter, the
    // derived `scopeKeyRef` a selection would be written with. Both are proposals; neither
    // confirms anything.
    scopeLinkAvailable: scopeLink.scopeLinkAvailable,
    scopeKeyRefCandidates: { ...scopeLink.scopeKeyRefCandidates },
  };
}

/** IR → resource-group summaries for the preview/exclusion toggles (AR-3). */
export function toResourceGroupSummaries(ir: Ir): ResourceGroupSummary[] {
  return ir.map((group) => ({
    resourceRef: group.resourceRef,
    name: group.name,
    operationCount: group.operations.length,
  }));
}
