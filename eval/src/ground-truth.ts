import { parse as parseYaml } from "yaml";

/**
 * Ground-truth parser (EH-1 crit 4) — turns a `scenarios/<name>/ground-truth.yaml`
 * fixture into a typed, normalized {@link GroundTruth}. The fixtures are the
 * authoritative statement of what a correct detection run should — and should
 * NOT — find (see `scenarios/README.md` *Ground truth* and each scenario's
 * `ground-truth.yaml` header).
 *
 * ## What "normalized" means
 *
 * The three vendored fixtures share a family of shapes but differ in detail
 * (a peer-peer pair keys its operations by CRUD action; a consumer-provider pair
 * lists an array of consumer operations each with a backend binding; scenario-4
 * splits a consumer response by backend app). This parser collapses those into
 * ONE model per pair kind so the scoring reads a single shape:
 *
 * - **operation references** ("GET /repos/{owner}/{repo}/issues") are parsed to
 *   `{ method, path }` — the file-path-independent operation IDENTITY the scoring
 *   aligns to the produced IR (never the raw string, never the spec file path).
 * - **field pairs** carry `source`/`target` (either may be `null`: a `null`
 *   `source` is the request-phase constant-synthesis case, a `null` `target` is
 *   an unmapped source) plus the ground-truth `transform` kind verbatim
 *   (including `direct`, which the concept's transform enum has no member for —
 *   the scoring maps it, this parser preserves it).
 * - **unknown keys are tolerated**, never rejected — the fixtures carry human
 *   notes (`note`, `companions`, `rejected-bindings`, `changeTimestamp`,
 *   `dedupKey`, …) the scoring does not read; matching is by resource / operation
 *   / field identity, so extra annotation is harmless.
 */

// ── Normalized model ─────────────────────────────────────────────────────────

/** The five CRUD actions a peer-peer pair keys its operations by. */
export const CRUD_ACTIONS = ["list", "read", "create", "update", "delete"] as const;
export type CrudAction = (typeof CRUD_ACTIONS)[number];

/** A file-path-independent operation identity: uppercased method + path. */
export interface GtOperationRef {
  readonly method: string;
  readonly path: string;
}

/** One field-level correspondence the ground truth asserts (or forbids). */
export interface GtFieldPair {
  /** `null` on a request-phase constant-synthesis entry (no consumer field in). */
  readonly source: string | null;
  /** `null` when the source field is expected to stay unmapped. */
  readonly target: string | null;
  /** The ground-truth transform kind verbatim (`direct` | `rename` | `coerce` | …), or `null`. */
  readonly transform: string | null;
}

/** One parameter-level (path/query/header) correspondence. */
export interface GtParameterPair {
  readonly source: string;
  readonly target: string | null;
  readonly transform: string | null;
}

/** A resource- or operation-scoped endpoint in a `negatives` entry. */
export type GtEndpoint =
  | { readonly kind: "resource"; readonly app: string; readonly resource: string }
  | { readonly kind: "operation"; readonly app: string; readonly operation: GtOperationRef };

/** The per-CRUD-action operation pairing on a peer-peer pair. */
export interface GtCrudOperation {
  readonly source: GtOperationRef | null;
  readonly target: GtOperationRef | null;
}

export interface GtPeerPair {
  readonly kind: "peer-peer";
  readonly sourceApp: string;
  readonly sourceResource: string;
  readonly targetApp: string;
  readonly targetResource: string;
  /** Whether this pair is a fork-calibration pair (scenario-4). */
  readonly calibration: boolean;
  readonly operations: ReadonlyMap<CrudAction, GtCrudOperation>;
  readonly identityKey: { readonly source: string | null; readonly target: string | null };
  readonly fields: readonly GtFieldPair[];
  /** "plausible" false-positives: reasonable shortlist guesses that MUST NOT be confidently field-mapped. */
  readonly plausibleFields: readonly GtFieldPair[];
  readonly unmappedSources: readonly string[];
  readonly unmappedTargets: readonly string[];
}

/** One consumer operation and how the ground truth expects it bound to backends. */
export interface GtConsumerOperation {
  readonly consumer: GtOperationRef;
  readonly aggregation: string | null;
  readonly backends: readonly { readonly app: string | null; readonly operation: GtOperationRef }[];
  readonly parameters: readonly GtParameterPair[];
  /** Request-phase field correspondences (a `null` source = constant synthesis). */
  readonly requestFields: readonly GtFieldPair[];
  /** Response-phase field correspondences (flattened across per-backend variants). */
  readonly responseFields: readonly GtFieldPair[];
}

export interface GtConsumerProviderPair {
  readonly kind: "consumer-provider";
  readonly sourceApp: string;
  readonly sourceResource: string;
  readonly targetApps: readonly string[];
  readonly operations: readonly GtConsumerOperation[];
}

export type GtPair = GtPeerPair | GtConsumerProviderPair;

export const NEGATIVE_VERDICTS = ["ambiguous", "no-counterpart", "incorrect-but-tempting"] as const;
export type NegativeVerdict = (typeof NEGATIVE_VERDICTS)[number];

export interface GtNegative {
  readonly source: GtEndpoint;
  readonly target: GtEndpoint | null;
  readonly verdict: NegativeVerdict;
}

export interface GroundTruth {
  readonly scenario: string;
  readonly pairs: readonly GtPair[];
  readonly negatives: readonly GtNegative[];
}

/** Thrown when a ground-truth document is structurally unparseable. */
export class GroundTruthParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GroundTruthParseError";
  }
}

// ── Narrowing helpers (over the untyped YAML tree) ───────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GroundTruthParseError(`${what} must be a mapping`);
  return value;
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new GroundTruthParseError(`${what} must be a sequence`);
  return value;
}

/** A string field, or `null` when absent/`null` — the fixtures use both interchangeably. */
function optString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  // Numbers/booleans occasionally appear (e.g. a bare version); coerce to string.
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function reqString(value: unknown, what: string): string {
  const s = optString(value);
  if (s === null) throw new GroundTruthParseError(`${what} must be a string`);
  return s;
}

/**
 * Parse a `"METHOD /path"` operation reference into its identity. Tolerates extra
 * whitespace and a trailing human note in parentheses (only the leading
 * `method path` token pair is identity). Returns `null` for a value that is not a
 * method+path pair (e.g. a bare note), so callers can skip it rather than crash.
 */
export function parseOperationRef(raw: string): GtOperationRef | null {
  const trimmed = raw.trim();
  const match = /^([A-Za-z]+)\s+(\/\S*)/.exec(trimmed);
  if (match === null) return null;
  const method = match[1];
  const path = match[2];
  if (method === undefined || path === undefined) return null;
  return { method: method.toUpperCase(), path };
}

function optOperationRef(value: unknown): GtOperationRef | null {
  const s = optString(value);
  if (s === null) return null;
  return parseOperationRef(s);
}

// ── Field / parameter parsing ────────────────────────────────────────────────

function parseFieldPair(value: unknown): GtFieldPair {
  const record = asRecord(value, "field entry");
  return {
    source: optString(record["source"]),
    target: optString(record["target"]),
    transform: optString(record["transform"]),
  };
}

function parseFieldList(value: unknown): GtFieldPair[] {
  if (value === undefined || value === null) return [];
  return asArray(value, "fields").map(parseFieldPair);
}

function parseParameterPair(value: unknown): GtParameterPair {
  const record = asRecord(value, "parameter entry");
  return {
    source: reqString(record["source"], "parameter.source"),
    target: optString(record["target"]),
    transform: optString(record["transform"]),
  };
}

// ── Peer-peer pair ───────────────────────────────────────────────────────────

function parseCrudOperations(value: unknown): ReadonlyMap<CrudAction, GtCrudOperation> {
  const operations = new Map<CrudAction, GtCrudOperation>();
  if (value === undefined || value === null) return operations;
  const record = asRecord(value, "operations");
  for (const action of CRUD_ACTIONS) {
    const entry = record[action];
    if (entry === undefined || entry === null) continue;
    const opRecord = asRecord(entry, `operations.${action}`);
    operations.set(action, {
      source: optOperationRef(opRecord["source"]),
      target: optOperationRef(opRecord["target"]),
    });
  }
  return operations;
}

function parseUnmapped(value: unknown): { source: string[]; target: string[] } {
  if (value === undefined || value === null) return { source: [], target: [] };
  const record = asRecord(value, "unmapped");
  const readList = (v: unknown): string[] =>
    v === undefined || v === null
      ? []
      : asArray(v, "unmapped list").flatMap((e) => {
          const s = optString(e);
          return s === null ? [] : [s];
        });
  return { source: readList(record["source"]), target: readList(record["target"]) };
}

function parsePeerPair(
  record: Record<string, unknown>,
  source: { app: string; resource: string },
  target: { app: string; resource: string },
): GtPeerPair {
  const identity = isRecord(record["identityKey"]) ? record["identityKey"] : {};
  const unmapped = parseUnmapped(record["unmapped"]);
  return {
    kind: "peer-peer",
    sourceApp: source.app,
    sourceResource: source.resource,
    targetApp: target.app,
    targetResource: target.resource,
    calibration: record["calibration"] === true,
    operations: parseCrudOperations(record["operations"]),
    identityKey: { source: optString(identity["source"]), target: optString(identity["target"]) },
    fields: parseFieldList(record["fields"]),
    plausibleFields: parseFieldList(record["plausible"]),
    unmappedSources: unmapped.source,
    unmappedTargets: unmapped.target,
  };
}

// ── Consumer-provider pair ───────────────────────────────────────────────────

function parseBackends(
  binding: Record<string, unknown>,
): { app: string | null; operation: GtOperationRef }[] {
  const backends: { app: string | null; operation: GtOperationRef }[] = [];
  // Single-backend form: `binding: { backend: "GET /tasks", aggregation }`.
  const single = optOperationRef(binding["backend"]);
  if (single !== null) backends.push({ app: null, operation: single });
  // Multi-backend form: `binding: { backends: [{ app, operation }], aggregation }`.
  if (Array.isArray(binding["backends"])) {
    for (const entry of binding["backends"]) {
      if (!isRecord(entry)) continue;
      const operation = optOperationRef(entry["operation"]);
      if (operation === null) continue;
      backends.push({ app: optString(entry["app"]), operation });
    }
  }
  return backends;
}

/**
 * Flatten a consumer op's response spec into a flat field-pair list. Scenario-3
 * uses a flat array; scenario-4 splits it into per-backend arrays keyed by app
 * (`gitea-forgejo`, `vikunja`, `mediator-annotated`) — every sub-array's entries
 * are legitimate expected pairs for their backend, so the scoring reads the union.
 */
function parseResponseFields(value: unknown): GtFieldPair[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(parseFieldPair);
  const record = asRecord(value, "response");
  return Object.values(record).flatMap((v) => (Array.isArray(v) ? v.map(parseFieldPair) : []));
}

function parseConsumerOperation(value: unknown): GtConsumerOperation | null {
  const record = asRecord(value, "consumer operation");
  const consumer = optOperationRef(record["consumer"]);
  if (consumer === null) return null;
  const binding = isRecord(record["binding"]) ? record["binding"] : {};
  const parameters =
    record["parameters"] === undefined || record["parameters"] === null
      ? []
      : asArray(record["parameters"], "parameters").map(parseParameterPair);
  return {
    consumer,
    aggregation: optString(binding["aggregation"]),
    backends: parseBackends(binding),
    parameters,
    requestFields: parseFieldList(record["request"]),
    responseFields: parseResponseFields(record["response"]),
  };
}

function parseConsumerProviderPair(
  record: Record<string, unknown>,
  source: { app: string; resource: string },
  target: Record<string, unknown>,
): GtConsumerProviderPair {
  const operations = asArray(record["operations"], "operations").flatMap((op) => {
    const parsed = parseConsumerOperation(op);
    return parsed === null ? [] : [parsed];
  });
  // Target apps: `target.app` (single, s3) or `target.apps` (list, s4); fall back
  // to the union of backend apps across operations.
  const targetApps = new Set<string>();
  const singleApp = optString(target["app"]);
  if (singleApp !== null) targetApps.add(singleApp);
  if (Array.isArray(target["apps"])) {
    for (const app of target["apps"]) {
      const s = optString(app);
      if (s !== null) targetApps.add(s);
    }
  }
  if (targetApps.size === 0) {
    for (const op of operations) {
      for (const backend of op.backends) {
        if (backend.app !== null) targetApps.add(backend.app);
      }
    }
  }
  return {
    kind: "consumer-provider",
    sourceApp: source.app,
    sourceResource: source.resource,
    targetApps: [...targetApps],
    operations,
  };
}

// ── Pair + endpoint dispatch ─────────────────────────────────────────────────

function parseResourceEndpoint(value: unknown, what: string): { app: string; resource: string } {
  const record = asRecord(value, what);
  return {
    app: reqString(record["app"], `${what}.app`),
    resource: reqString(record["resource"], `${what}.resource`),
  };
}

function parsePair(value: unknown): GtPair {
  const record = asRecord(value, "pair");
  const kind = reqString(record["kind"], "pair.kind");
  const source = parseResourceEndpoint(record["source"], "pair.source");
  if (kind === "consumer-provider") {
    return parseConsumerProviderPair(record, source, asRecord(record["target"], "pair.target"));
  }
  if (kind === "peer-peer") {
    return parsePeerPair(record, source, parseResourceEndpoint(record["target"], "pair.target"));
  }
  throw new GroundTruthParseError(`unknown pair kind: ${kind}`);
}

function parseEndpoint(value: unknown): GtEndpoint | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, "endpoint");
  const app = reqString(record["app"], "endpoint.app");
  const operation = optOperationRef(record["operation"]);
  if (operation !== null) return { kind: "operation", app, operation };
  const resource = optString(record["resource"]);
  if (resource !== null) return { kind: "resource", app, resource };
  throw new GroundTruthParseError("endpoint must carry a resource or an operation");
}

function isNegativeVerdict(value: string): value is NegativeVerdict {
  return (NEGATIVE_VERDICTS as readonly string[]).includes(value);
}

function parseNegative(value: unknown): GtNegative {
  const record = asRecord(value, "negative");
  const source = parseEndpoint(record["source"]);
  if (source === null) throw new GroundTruthParseError("negative.source is required");
  const verdict = reqString(record["verdict"], "negative.verdict");
  if (!isNegativeVerdict(verdict)) {
    throw new GroundTruthParseError(`unknown negative verdict: ${verdict}`);
  }
  return { source, target: parseEndpoint(record["target"]), verdict };
}

/**
 * Parse a `ground-truth.yaml` document (its raw text) into a typed
 * {@link GroundTruth}. Throws {@link GroundTruthParseError} on a structurally
 * invalid document; tolerates the human-note keys the fixtures carry.
 */
export function parseGroundTruth(yamlText: string): GroundTruth {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GroundTruthParseError(`invalid YAML: ${message}`);
  }
  const root = asRecord(doc, "ground truth");
  const meta = isRecord(root["meta"]) ? root["meta"] : {};
  const scenario = optString(meta["scenario"]) ?? "unknown-scenario";
  const pairs =
    root["pairs"] === undefined || root["pairs"] === null
      ? []
      : asArray(root["pairs"], "pairs").map(parsePair);
  const negatives =
    root["negatives"] === undefined || root["negatives"] === null
      ? []
      : asArray(root["negatives"], "negatives").map(parseNegative);
  return { scenario, pairs, negatives };
}
