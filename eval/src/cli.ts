import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "@mediator/config";
import { type LLMMappingProvider, OllamaProvider, PROMPT_VERSION } from "@mediator/llm";

import { DEFAULT_HARNESS_CONFIG } from "./config.js";
import { buildFakeProvider } from "./fake-script.js";
import { formatSummary, type ScenarioReport } from "./report.js";
import { loadScenario, resolveScenarioDir } from "./scenario-loader.js";
import { runScenario } from "./runner.js";

/**
 * `eval` CLI (EH-1): run detection over a scenario's vendored specs with the
 * configured provider and write + print a scored report. This is the **live** run
 * — deliberately OUTSIDE `pnpm verify` (its numbers depend on the model and it is
 * slow). The deterministic scoring is unit-tested separately.
 *
 * Usage:
 *   pnpm --filter @mediator/eval run eval -- --scenario <name> [--provider ollama|fake]
 *
 * `--provider ollama` (default) reads `config.mappingLlm` (fail-fast on a bad env);
 * `--provider fake` uses a scripted `FakeProvider` and needs no LLM/DB env at all.
 */

interface CliArgs {
  readonly scenario: string;
  readonly provider: "ollama" | "fake";
}

const USAGE =
  "Usage: pnpm --filter @mediator/eval run eval -- --scenario <name> [--provider ollama|fake]";

function parseArgs(argv: readonly string[]): CliArgs {
  let scenario: string | undefined;
  let provider: "ollama" | "fake" = "ollama";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scenario" || arg === "-s") {
      scenario = argv[i + 1];
      i += 1;
    } else if (arg === "--provider" || arg === "-p") {
      const value = argv[i + 1];
      if (value !== "ollama" && value !== "fake") {
        throw new Error(`--provider must be "ollama" or "fake" (got ${value ?? "nothing"})`);
      }
      provider = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    }
  }
  if (scenario === undefined || scenario === "") {
    throw new Error(`Missing --scenario.\n${USAGE}`);
  }
  return { scenario, provider };
}

/** The fake path has no LLM config; use the same default retry cap the config schema defaults to. */
const FAKE_MAX_RETRIES = 3;

function buildProvider(
  args: CliArgs,
  scenario: string,
): { provider: LLMMappingProvider; maxRetries: number } {
  if (args.provider === "fake") {
    return { provider: buildFakeProvider(scenario), maxRetries: FAKE_MAX_RETRIES };
  }
  const config = loadConfig();
  return {
    provider: new OllamaProvider({ config: config.mappingLlm }),
    maxRetries: config.mappingLlm.maxRetries,
  };
}

async function writeReport(report: ScenarioReport): Promise<string> {
  const reportsDir = fileURLToPath(new URL("../reports", import.meta.url));
  await mkdir(reportsDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const file = path.join(reportsDir, `${report.scenario}-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return file;
}

async function main(): Promise<void> {
  const repoEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(repoEnvPath)) {
    process.loadEnvFile(repoEnvPath);
  }

  const args = parseArgs(process.argv.slice(2));
  const scenarioDir = resolveScenarioDir(args.scenario);
  const scenario = await loadScenario(scenarioDir);
  const { provider, maxRetries } = buildProvider(args, scenario.scenario);

  let calls = 0;
  const onMetrics = (): void => {
    calls += 1;
  };

  console.info(
    `[eval] scenario=${scenario.scenario} provider=${provider.providerId}/${provider.model} specs=${String(scenario.specs.length)}`,
  );
  const report = await runScenario(scenario, {
    provider,
    maxRetries,
    promptVersion: PROMPT_VERSION,
    config: DEFAULT_HARNESS_CONFIG,
    onMetrics,
  });

  const file = await writeReport(report);
  console.info(`\n${formatSummary(report)}`);
  console.info(`\n[eval] LLM calls: ${String(calls)}`);
  console.info(`[eval] report written: ${file}`);
}

try {
  await main();
} catch (error) {
  console.error("[eval] failed:", error);
  process.exitCode = 1;
}
