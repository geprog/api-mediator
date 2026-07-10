import {
  RESOURCE_BINDING_REF_KINDS,
  type ApiSpecMetadataDto,
  type RegisteredAppDto,
  type ResourceBindingDto,
  type ResourceGroupSummary,
} from "@mediator/contracts";
import type {
  ApiSpec,
  AppCapabilities,
  Ir,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";

import { refApplicable } from "../modules/resource-bindings.js";

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
 * `ResourceBinding` → wire DTO (RB-2/RB-3): every ref kind is listed with its
 * value, confirmation state, and `applicable` flag (computed from the owning
 * app's `capabilities`), so a caller can tell not-applicable / unconfirmed /
 * confirmed apart in one pass.
 */
export function toResourceBindingDto(
  binding: ResourceBinding,
  capabilities: AppCapabilities,
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
  return {
    id: binding.id,
    apiSpecId: binding.apiSpecId,
    resourceRef: binding.resourceRef,
    refs,
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
