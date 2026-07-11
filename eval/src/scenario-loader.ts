import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ApiSpec, ApiSpecRole } from "@mediator/domain";
import { buildIr, computeContentHash } from "@mediator/ir";
import { parse as parseYaml } from "yaml";

import { type GroundTruth, parseGroundTruth } from "./ground-truth.js";

/**
 * Scenario loader (EH-1 crit 1/5) — turns a `scenarios/<name>/` directory into
 * the in-memory, DB-free inputs the harness runs detection over.
 *
 * Per the adopted decision (README open question) the harness invokes the
 * detection engine DIRECTLY, bypassing the Event Bus, the `SpecIngested` trigger,
 * and DB persistence — so scoring is a function of inputs and provider only. This
 * loader therefore synthesizes the minimal `ApiSpec` objects the non-persisting
 * `detectForSpec` path needs (id / appId / role / `parsedIR` / status /
 * exclusions), with the IR built by `@mediator/ir` exactly as ingestion would.
 *
 * Detection input is the vendored **`specs/oas3/*.trimmed.oas3.json`** for
 * providers and **`specs/consumer/*.yaml`** for consumers — the trimmed OAS3
 * conversions are the default detection input that preserve each overlap story at
 * a fraction of the LLM cost, and the ground-truth refs reference the trimmed
 * specs (see `scenarios/README.md`).
 */

const CREATED_AT = new Date("2026-07-10T00:00:00.000Z");

/** One loaded spec: the scenario/ground-truth app name plus the synthesized `ApiSpec`. */
export interface LoadedSpec {
  /** The app name as used by the ground truth (the spec-file prefix, e.g. `gitea`, `todo-widget`). */
  readonly app: string;
  readonly spec: ApiSpec;
}

export interface LoadedScenario {
  /** The scenario directory basename (e.g. `scenario-1-small-overlap`). */
  readonly scenario: string;
  readonly scenarioDir: string;
  /** Providers first, then consumers, each sorted by app name — a stable registration order. */
  readonly specs: readonly LoadedSpec[];
  readonly groundTruth: GroundTruth;
}

/** The repo's `scenarios/` directory, resolved relative to this package. */
export function scenariosRoot(): string {
  // eval/src/scenario-loader.ts → eval/ → repo root → scenarios/
  return fileURLToPath(new URL("../../scenarios", import.meta.url));
}

/**
 * Resolve a `--scenario` argument to a scenario directory: an existing absolute
 * or relative path is used as-is; otherwise it is looked up under
 * {@link scenariosRoot} (so both `scenario-1-small-overlap` and a full path work).
 */
export function resolveScenarioDir(scenarioArg: string): string {
  if (scenarioArg.includes(path.sep) || path.isAbsolute(scenarioArg)) {
    return path.resolve(scenarioArg);
  }
  return path.join(scenariosRoot(), scenarioArg);
}

/** Parse a spec document's raw text into a JSON object (`.json` → JSON, `.yaml` → YAML). */
function parseDocument(text: string, file: string): Record<string, unknown> {
  const parsed: unknown = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Spec ${file} did not parse to a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function loadOne(app: string, role: ApiSpecRole, file: string): Promise<LoadedSpec> {
  const text = await readFile(file, "utf8");
  const rawDocument = parseDocument(text, file);
  const parsedIR = await buildIr(rawDocument);
  const spec: ApiSpec = {
    id: `spec-${app}`,
    appId: `app-${app}`,
    role,
    rawDocument,
    parsedIR,
    analysisExclusions: [],
    version: 1,
    contentHash: computeContentHash(rawDocument),
    status: "active",
    createdAt: CREATED_AT,
  };
  return { app, spec };
}

/** Files under `specs/oas3/` matching `*.trimmed.oas3.json`; app = prefix before the first `.`. */
async function providerFiles(scenarioDir: string): Promise<{ app: string; file: string }[]> {
  const dir = path.join(scenarioDir, "specs", "oas3");
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((name) => name.endsWith(".trimmed.oas3.json"))
    .map((name) => ({ app: name.slice(0, name.indexOf(".")), file: path.join(dir, name) }))
    .sort((a, b) => a.app.localeCompare(b.app));
}

/** Files under `specs/consumer/` matching `*.yaml`; app = basename without extension. */
async function consumerFiles(scenarioDir: string): Promise<{ app: string; file: string }[]> {
  const dir = path.join(scenarioDir, "specs", "consumer");
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map((name) => ({ app: name.slice(0, name.lastIndexOf(".")), file: path.join(dir, name) }))
    .sort((a, b) => a.app.localeCompare(b.app));
}

/**
 * Load a scenario: its trimmed provider specs and consumer specs (each decomposed
 * to IR and wrapped in a synthesized `ApiSpec`) plus its parsed `ground-truth.yaml`.
 * Providers are ordered before consumers so the runner's incremental registration
 * forms every peer pair before a consumer joins.
 */
export async function loadScenario(scenarioDir: string): Promise<LoadedScenario> {
  const [providers, consumers, groundTruthText] = await Promise.all([
    providerFiles(scenarioDir),
    consumerFiles(scenarioDir),
    readFile(path.join(scenarioDir, "ground-truth.yaml"), "utf8"),
  ]);

  const specs = await Promise.all([
    ...providers.map((p) => loadOne(p.app, "PROVIDER", p.file)),
    ...consumers.map((c) => loadOne(c.app, "CONSUMER", c.file)),
  ]);

  if (specs.length === 0) {
    throw new Error(`No specs found under ${scenarioDir}/specs (oas3 trimmed or consumer)`);
  }

  return {
    scenario: path.basename(scenarioDir),
    scenarioDir,
    specs,
    groundTruth: parseGroundTruth(groundTruthText),
  };
}
