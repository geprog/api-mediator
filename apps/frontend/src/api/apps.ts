import {
  appListResponseSchema,
  appSpecsResponseSchema,
  registerAppResponseSchema,
  type AppListResponse,
  type AppSpecsResponse,
  type RegisterAppRequest,
  type RegisterAppResponse,
} from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * App registration + browsing routes (AR-1, AR-2). Each function validates its
 * response against the `@mediator/contracts` schema at the boundary.
 */

/** `POST /api/apps` — register an app + its role-tagged specs (AR-1). */
export function registerApp(request: RegisterAppRequest): Promise<RegisterAppResponse> {
  return apiRequest("/api/apps", { method: "POST", body: request }, registerAppResponseSchema);
}

/** `GET /api/apps` — list all registered apps (AR-2 criterion 1). */
export function listApps(): Promise<AppListResponse> {
  return apiRequest("/api/apps", { method: "GET" }, appListResponseSchema);
}

/** `GET /api/apps/:id/specs` — the app's spec metadata (AR-2 criterion 2). */
export function getAppSpecs(appId: string): Promise<AppSpecsResponse> {
  return apiRequest(
    `/api/apps/${encodeURIComponent(appId)}/specs`,
    { method: "GET" },
    appSpecsResponseSchema,
  );
}
