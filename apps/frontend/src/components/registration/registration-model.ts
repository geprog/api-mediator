import type {
  CredentialMaterialDto,
  CredentialSecretDto,
  RegisterAppRequest,
  RegisterSpecRequest,
  ResourceGroupSummary,
  ValidationIssue,
} from "@mediator/contracts";
import { apiSpecRoleSchema, assertNever, type ApiSpecRole } from "@mediator/domain";

/**
 * Pure model for the registration form (AR-1/AR-3): the reactive component holds
 * these plain shapes, and this module derives client-side validation and the
 * `RegisterAppRequest` from them — with **no** Vue or DOM dependency, so the
 * rules (baseUrl-required-when-PROVIDER, all-or-nothing capabilities, per-type
 * credential completeness) are unit-testable without mounting.
 *
 * The backend remains authoritative; these client checks mirror it for UX and to
 * avoid a doomed round-trip (AR-3 criterion 4).
 */

/** The credential secret kinds the form offers — `adapterToken` is intentionally absent (CR-1 criterion 5). */
export type CredentialFormType = CredentialSecretDto["type"];
export const CREDENTIAL_FORM_TYPES: readonly CredentialFormType[] = [
  "apiKey",
  "basicAuth",
  "oauth2",
  "custom",
];

/** One key/value row for a `custom` credential. */
export interface CustomCredentialEntry {
  key: string;
  value: string;
}

/** Write-only credential inputs. Never populated from server data (CR-2). */
export interface CredentialFormState {
  type: CredentialFormType;
  apiKey: string;
  username: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  customEntries: CustomCredentialEntry[];
  /** Comma-separated scopes; parsed to an array at submit. */
  scopes: string;
}

/** One spec row: its uploaded document, role, and chosen exclusions. */
export interface SpecFormState {
  role: ApiSpecRole;
  fileName: string | null;
  /** The parsed OpenAPI document, or `null` until a file is accepted. */
  document: Record<string, unknown> | null;
  /** Resource groups from the preview parse (AR-3 criterion 2), for exclusion toggles. */
  resourceGroups: ResourceGroupSummary[];
  /** `resourceRef`s the operator chose to exclude from analysis (SI-4). */
  excludedRefs: string[];
  /** A per-row parse/preview error message, if any. */
  error: string | null;
}

/** Capabilities are all-or-nothing on the wire (AR-1 criterion 2). */
export interface CapabilitiesFormState {
  /** When false, capabilities are omitted and the backend defaults them. */
  declare: boolean;
  supportsPolling: boolean;
  supportsDeltaQuery: boolean;
  supportsChangeTimestamps: boolean;
  /** Poll interval (ms); required only when `declare` is true. */
  defaultPollInterval: number | null;
}

export interface RegistrationFormState {
  name: string;
  baseUrl: string;
  capabilities: CapabilitiesFormState;
  credentialEnabled: boolean;
  credential: CredentialFormState;
  specs: SpecFormState[];
}

/** The outcome of preparing a submission: either client-side issues, or a ready request. */
export type PrepareResult =
  | { readonly status: "invalid"; readonly issues: ValidationIssue[] }
  | { readonly status: "ready"; readonly request: RegisterAppRequest };

export function createEmptyCredential(): CredentialFormState {
  return {
    type: "apiKey",
    apiKey: "",
    username: "",
    password: "",
    accessToken: "",
    refreshToken: "",
    customEntries: [{ key: "", value: "" }],
    scopes: "",
  };
}

export function createEmptySpec(): SpecFormState {
  return {
    role: apiSpecRoleSchema.enum.PROVIDER,
    fileName: null,
    document: null,
    resourceGroups: [],
    excludedRefs: [],
    error: null,
  };
}

export function createEmptyFormState(): RegistrationFormState {
  return {
    name: "",
    baseUrl: "",
    capabilities: {
      declare: false,
      supportsPolling: false,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: null,
    },
    credentialEnabled: false,
    credential: createEmptyCredential(),
    specs: [createEmptySpec()],
  };
}

/** AR-1 criterion 3 / AR-3 criterion 4: a PROVIDER spec makes `baseUrl` required. */
export function requiresBaseUrl(state: RegistrationFormState): boolean {
  return state.specs.some((spec) => spec.role === apiSpecRoleSchema.enum.PROVIDER);
}

function collectCredentialIssues(credential: CredentialFormState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  switch (credential.type) {
    case "apiKey":
      if (credential.apiKey.trim() === "") {
        issues.push({ path: "credential.secret.apiKey", message: "An API key is required." });
      }
      break;
    case "basicAuth":
      if (credential.username.trim() === "") {
        issues.push({ path: "credential.secret.username", message: "A username is required." });
      }
      if (credential.password === "") {
        issues.push({ path: "credential.secret.password", message: "A password is required." });
      }
      break;
    case "oauth2":
      if (credential.accessToken.trim() === "") {
        issues.push({
          path: "credential.secret.accessToken",
          message: "An access token is required.",
        });
      }
      break;
    case "custom": {
      const populated = credential.customEntries.filter((entry) => entry.key.trim() !== "");
      if (populated.length === 0) {
        issues.push({
          path: "credential.secret.values",
          message: "At least one key/value entry is required for a custom credential.",
        });
      }
      break;
    }
    default:
      assertNever(credential.type);
  }
  return issues;
}

/** Collect all client-side validation issues (mirrors AR-1's server rules for UX). */
export function collectClientIssues(state: RegistrationFormState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (state.name.trim() === "") {
    issues.push({ path: "name", message: "A name is required." });
  }

  if (requiresBaseUrl(state) && state.baseUrl.trim() === "") {
    issues.push({
      path: "baseUrl",
      message: "A baseUrl is required when any spec has the PROVIDER role.",
    });
  }

  if (state.specs.length === 0) {
    issues.push({ path: "specs", message: "At least one spec is required." });
  }
  state.specs.forEach((spec, index) => {
    if (spec.document === null) {
      issues.push({
        path: `specs.${String(index)}.document`,
        message: "Upload an OpenAPI document for this spec.",
      });
    }
  });

  if (state.capabilities.declare) {
    const interval = state.capabilities.defaultPollInterval;
    if (interval === null || !Number.isInteger(interval) || interval <= 0) {
      issues.push({
        path: "capabilities.defaultPollInterval",
        message: "A positive poll interval (ms) is required when declaring capabilities.",
      });
    }
  }

  if (state.credentialEnabled) {
    issues.push(...collectCredentialIssues(state.credential));
  }

  return issues;
}

function buildCredentialSecret(credential: CredentialFormState): CredentialSecretDto {
  switch (credential.type) {
    case "apiKey":
      return { type: "apiKey", apiKey: credential.apiKey };
    case "basicAuth":
      return { type: "basicAuth", username: credential.username, password: credential.password };
    case "oauth2":
      return {
        type: "oauth2",
        accessToken: credential.accessToken,
        ...(credential.refreshToken.trim() !== "" ? { refreshToken: credential.refreshToken } : {}),
      };
    case "custom": {
      const values: Record<string, string> = {};
      for (const entry of credential.customEntries) {
        if (entry.key.trim() !== "") {
          values[entry.key] = entry.value;
        }
      }
      return { type: "custom", values };
    }
    default:
      return assertNever(credential.type);
  }
}

function buildCredential(credential: CredentialFormState): CredentialMaterialDto {
  const scopes = credential.scopes
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
  return {
    secret: buildCredentialSecret(credential),
    ...(scopes.length > 0 ? { scopes } : {}),
  };
}

function buildSpecRequest(spec: SpecFormState): RegisterSpecRequest {
  if (spec.document === null) {
    throw new Error("Cannot build a spec request without a parsed document.");
  }
  return {
    role: spec.role,
    document: spec.document,
    ...(spec.excludedRefs.length > 0 ? { analysisExclusions: [...spec.excludedRefs] } : {}),
  };
}

function buildCapabilities(
  capabilities: CapabilitiesFormState,
): RegisterAppRequest["capabilities"] {
  if (!capabilities.declare || capabilities.defaultPollInterval === null) {
    return undefined;
  }
  return {
    supportsPolling: capabilities.supportsPolling,
    supportsDeltaQuery: capabilities.supportsDeltaQuery,
    supportsChangeTimestamps: capabilities.supportsChangeTimestamps,
    defaultPollInterval: capabilities.defaultPollInterval,
  };
}

/**
 * Validate the form and, when valid, build the `RegisterAppRequest`. Optional
 * fields are **omitted** (never set to `undefined`) so the request matches the
 * contract under `exactOptionalPropertyTypes`.
 */
export function prepareRegistration(state: RegistrationFormState): PrepareResult {
  const issues = collectClientIssues(state);
  if (issues.length > 0) {
    return { status: "invalid", issues };
  }

  const capabilities = buildCapabilities(state.capabilities);
  const request: RegisterAppRequest = {
    name: state.name.trim(),
    specs: state.specs.map(buildSpecRequest),
    ...(state.baseUrl.trim() !== "" ? { baseUrl: state.baseUrl.trim() } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(state.credentialEnabled ? { credential: buildCredential(state.credential) } : {}),
  };
  return { status: "ready", request };
}
