import {
  apiSpecRoleSchema,
  apiSpecStatusSchema,
  appCapabilitiesSchema,
  registeredAppStatusSchema,
} from "@mediator/domain";
import { z } from "zod";

import { isoDateTimeSchema } from "./common.js";
import { credentialMaterialDtoSchema } from "./credentials.js";

/**
 * DTOs for app registration and browsing (AR-1, AR-2). Domain sub-shapes
 * (`role`, `status`, `capabilities`) are reused from `@mediator/domain`; the
 * boundary-specific transforms are: `Date` → {@link isoDateTimeSchema}, and the
 * omission of `rawDocument`/`parsedIR`/any credential material from every
 * response DTO.
 */

/**
 * The raw OpenAPI document as submitted — a JSON object. The frontend parses an
 * uploaded spec file to JSON before sending; a YAML upload is parsed client-side
 * first. Kept `Record<string, unknown>` to match `ApiSpec.rawDocument`; the
 * backend hands it to `@mediator/ir`'s `buildIr`, which resolves and decomposes
 * it (and rejects a non-OpenAPI document with a 400).
 */
export const openApiDocumentSchema = z.record(z.string(), z.unknown());

/**
 * One spec in a registration request: an OpenAPI `document`, its `role`, and an
 * optional set of `analysisExclusions` (resource-group `resourceRef`s to keep
 * out of later mapping analysis — SI-4). Exclusions are validated against the
 * built IR server-side, so an unknown `resourceRef` is rejected there.
 */
export const registerSpecRequestSchema = z.object({
  role: apiSpecRoleSchema,
  document: openApiDocumentSchema,
  analysisExclusions: z.array(z.string()).optional(),
});
export type RegisterSpecRequest = z.infer<typeof registerSpecRequestSchema>;

/**
 * `POST /api/apps` request body (AR-1). `capabilities` is all-or-nothing: when
 * provided it carries all four fields exactly (AR-1 criterion 2); when omitted
 * the server defaults conservatively (all-false + the configured
 * `defaultPollInterval`). `baseUrl`'s PROVIDER-required rule (AR-1 criterion 3)
 * and the atomic multi-spec parse are enforced by the orchestration, not by this
 * schema, so their failures surface as domain 400s with clear messages.
 */
export const registerAppRequestSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  capabilities: appCapabilitiesSchema.optional(),
  credential: credentialMaterialDtoSchema.optional(),
  specs: z.array(registerSpecRequestSchema).min(1),
});
export type RegisterAppRequest = z.infer<typeof registerAppRequestSchema>;

/**
 * A `RegisteredApp` on the wire (AR-1 response, AR-2 list). `createdAt` is an ISO
 * string; `baseUrl` is absent for a consumer-only app. No credential field.
 */
export const registeredAppDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: registeredAppStatusSchema,
  baseUrl: z.string().optional(),
  capabilities: appCapabilitiesSchema,
  createdAt: isoDateTimeSchema,
});
export type RegisteredAppDto = z.infer<typeof registeredAppDtoSchema>;

/**
 * `ApiSpec` **metadata** on the wire (AR-2 criterion 2). Deliberately excludes
 * `rawDocument` and `parsedIR` (AR-2 criterion 3) — the IR is a separate
 * endpoint. `analysisExclusions` is included because it is operator-set,
 * non-secret, and drives the SI-4 exclusion editor.
 */
export const apiSpecMetadataDtoSchema = z.object({
  id: z.string(),
  appId: z.string(),
  role: apiSpecRoleSchema,
  version: z.number().int().positive(),
  contentHash: z.string(),
  status: apiSpecStatusSchema,
  analysisExclusions: z.array(z.string()),
  createdAt: isoDateTimeSchema,
});
export type ApiSpecMetadataDto = z.infer<typeof apiSpecMetadataDtoSchema>;

/**
 * `POST /api/apps` response (AR-1 criterion 1): the created app plus its stored
 * specs' metadata. No credential material (AR-1 criterion 10).
 */
export const registerAppResponseSchema = z.object({
  app: registeredAppDtoSchema,
  specs: z.array(apiSpecMetadataDtoSchema),
});
export type RegisterAppResponse = z.infer<typeof registerAppResponseSchema>;

/** `GET /api/apps` response (AR-2 criterion 1): all apps, unpaginated. */
export const appListResponseSchema = z.object({
  apps: z.array(registeredAppDtoSchema),
});
export type AppListResponse = z.infer<typeof appListResponseSchema>;

/** `GET /api/apps/:id/specs` response (AR-2 criterion 2): a spec-metadata list. */
export const appSpecsResponseSchema = z.object({
  specs: z.array(apiSpecMetadataDtoSchema),
});
export type AppSpecsResponse = z.infer<typeof appSpecsResponseSchema>;

/**
 * `POST /api/apps/:id/disable` and `.../enable` (operator) — AL-1: the app in its new
 * state. Both transitions return the same shape; the resulting `status`
 * (`disabled` / `active`) is what distinguishes them. Disable is **reversible** and
 * carries no cascade, so — unlike deregistration — it needs no confirmation payload.
 */
export const appLifecycleTransitionResponseSchema = z.object({
  app: registeredAppDtoSchema,
});
export type AppLifecycleTransitionResponse = z.infer<typeof appLifecycleTransitionResponseSchema>;

/**
 * `POST /api/apps/:id/deregister` (operator) — AL-2.1: the **explicit confirmation** a
 * destructive deregistration requires (README open question 5). `confirm` must repeat the
 * target app's exact `name`; a bare `POST` (no body, or a body without `confirm`) fails
 * validation before any cascade runs, so an app can never be deregistered by accident.
 *
 * The value is checked against the *resolved* app inside the transaction, so a stale or
 * copy-pasted name from another app is rejected too.
 */
export const deregisterAppRequestSchema = z.object({
  confirm: z.string().min(1),
});
export type DeregisterAppRequest = z.infer<typeof deregisterAppRequestSchema>;

/**
 * AL-2.8 — what the deregister cascade did, in **counts only** (no ids, no names): the
 * same summary that is attributed to the operator in the audit log, returned so the
 * operator surface can report the cascade it just ran.
 */
export const appDeregistrationSummaryDtoSchema = z.object({
  syncRulesDeleted: z.number().int().nonnegative(),
  adapterEndpointsTornDown: z.number().int().nonnegative(),
  adapterBindingsDeleted: z.number().int().nonnegative(),
  adapterEndpointsRevertedToNotYetMapped: z.number().int().nonnegative(),
  approvedMappingsArchived: z.number().int().nonnegative(),
  counterpartLinksCleared: z.number().int().nonnegative(),
  apiSpecsArchived: z.number().int().nonnegative(),
  recordLinksArchived: z.number().int().nonnegative(),
  syncFieldStatesArchived: z.number().int().nonnegative(),
  scopeLinksArchived: z.number().int().nonnegative(),
  credentialsDeleted: z.number().int().nonnegative(),
  graphEdgesRecomputed: z.number().int().nonnegative(),
  endpointCachesDropped: z.number().int().nonnegative(),
});
export type AppDeregistrationSummaryDto = z.infer<typeof appDeregistrationSummaryDtoSchema>;

/**
 * `POST /api/apps/:id/deregister` response (AL-2): the app row as it stands after the
 * cascade — **retained** as the audit anchor its archived specs/mappings still reference,
 * and out of service (`status = disabled`) — plus the cascade summary.
 */
export const deregisterAppResponseSchema = z.object({
  app: registeredAppDtoSchema,
  cascade: appDeregistrationSummaryDtoSchema,
});
export type DeregisterAppResponse = z.infer<typeof deregisterAppResponseSchema>;
