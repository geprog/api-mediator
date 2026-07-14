import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Landscape lifecycle + connection details for the **SU-6 capstone journey** — the
 * one e2e that runs against the **real** running `scenarios/scenario-1-small-overlap`
 * landscape (Gitea + Vikunja) rather than a fake backend. Everything here concerns the
 * *containers* the mediator polls/writes; the mediator itself is the ordinary e2e
 * backend the Playwright `webServer` boots.
 *
 * The journey is **landscape-gated**: if Docker or the landscape is unreachable the
 * spec skips (never fails), so `pnpm --filter @mediator/e2e test:e2e` on a box with only
 * the compose Postgres up still passes. Bring the landscape up manually with
 * `cd scenarios/scenario-1-small-overlap && docker compose up -d --wait && ./bootstrap.sh
 * && ./seed.sh`, or let {@link ensureScenario1Landscape} do it.
 */

/** The scenario-1 directory (worktree-relative, resolved from this file). */
const SCENARIO_DIR = fileURLToPath(
  new URL("../../../../scenarios/scenario-1-small-overlap", import.meta.url),
);
const TOKENS_FILE = `${SCENARIO_DIR}/.tokens.env`;

/** Fixed host ports from the scenario `.env` (port scheme `1<scenario><app>`). */
export const GITEA_PORT = 11300;
export const VIKUNJA_PORT = 11400;

/** The API base URLs the mediator registers as each app's `baseUrl` (real containers). */
export const GITEA_BASE_URL = `http://localhost:${String(GITEA_PORT)}/api/v1`;
export const VIKUNJA_BASE_URL = `http://localhost:${String(VIKUNJA_PORT)}/api/v1`;

/** The container-owner + repo/project the scenario seeds (see `shared/fixtures.env`). */
export const GITEA_OWNER = "alice";
export const GITEA_REPO = "phoenix";

/** The two live API tokens `bootstrap.sh` writes to the gitignored `.tokens.env`. */
export interface LandscapeTokens {
  readonly gitea: string;
  readonly vikunja: string;
}

/** Parse a `KEY=value` env file into a record (ignoring comments/blank lines). */
function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Read the ephemeral `.tokens.env` `bootstrap.sh` produced. Throws if absent (the
 * landscape was not bootstrapped) — callers gate on {@link isLandscapeReady} first.
 * Never commit these tokens: they are throwaway credentials for local containers.
 */
export function readLandscapeTokens(): LandscapeTokens {
  const parsed = parseEnvFile(readFileSync(TOKENS_FILE, "utf8"));
  const gitea = parsed["GITEA_TOKEN"];
  const vikunja = parsed["VIKUNJA_TOKEN"];
  if (gitea === undefined || vikunja === undefined) {
    throw new Error(".tokens.env is missing GITEA_TOKEN/VIKUNJA_TOKEN — run bootstrap.sh");
  }
  return { gitea, vikunja };
}

/** True when the given URL answers below 500 within `timeoutMs` (a readiness probe). */
async function probe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether both containers answer their health/info endpoint (ignores bootstrap state). */
async function areContainersUp(): Promise<boolean> {
  const [gitea, vikunja] = await Promise.all([
    probe(`http://localhost:${String(GITEA_PORT)}/api/healthz`, 2_000),
    probe(`http://localhost:${String(VIKUNJA_PORT)}/api/v1/info`, 2_000),
  ]);
  return gitea && vikunja;
}

/**
 * Whether the live landscape is reachable AND bootstrapped: both apps answer, and
 * `.tokens.env` carries both tokens. This is the guard the journey skips on — it never
 * brings anything up, only observes.
 */
export async function isLandscapeReady(): Promise<boolean> {
  if (!(await areContainersUp())) {
    return false;
  }
  try {
    readLandscapeTokens();
    return true;
  } catch {
    return false;
  }
}

/** Whether the `docker` CLI is available (a bring-up precondition). */
export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether the scenario's `seed.sh` fixtures already exist (the alice/phoenix repo is present). */
async function hasSeedData(tokens: LandscapeTokens): Promise<boolean> {
  return probe0(`${GITEA_BASE_URL}/repos/${GITEA_OWNER}/${GITEA_REPO}`, tokens.gitea);
}

/** A 2xx probe with a Gitea token (distinct from {@link probe}, which allows 4xx). */
async function probe0(url: string, giteaToken: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { authorization: `token ${giteaToken}` } });
    return response.ok;
  } catch {
    return false;
  }
}

/** The outcome of {@link ensureScenario1Landscape}. `reused` = it was already up (do NOT tear down). */
export type LandscapeBringUp = "reused" | "started" | "unavailable";

/**
 * Make the scenario-1 landscape ready, reusing a running one as-is. Idempotent and
 * safe to call from a fresh worktree against already-running containers:
 *
 *  - containers already up → do not `up` (so we never tear a developer's landscape down);
 *  - `bootstrap.sh` is always (re-)run — it is idempotent (unique token names), and it is
 *    what writes this worktree's `.tokens.env`;
 *  - `seed.sh` (create-only, NOT re-runnable) runs **only** when the fixtures are absent.
 *
 * Returns `started` only when *this* call ran `docker compose up` — the single case
 * {@link teardownScenario1Landscape} should tear down. `unavailable` when Docker is absent.
 */
export async function ensureScenario1Landscape(): Promise<LandscapeBringUp> {
  // Already up AND bootstrapped → reuse as-is (the common dev path — the operator brought
  // it up per the scenario README); never re-bootstrap or tear down someone's landscape.
  if (await isLandscapeReady()) {
    return "reused";
  }
  const wasUp = await areContainersUp();
  if (!wasUp && !isDockerAvailable()) {
    return "unavailable";
  }
  const run = (command: string, args: string[]): void => {
    execFileSync(command, args, { cwd: SCENARIO_DIR, stdio: "inherit", timeout: 300_000 });
  };
  ensureScenarioEnvFile();
  if (!wasUp) {
    run("docker", ["compose", "up", "-d", "--wait"]);
  }
  run("bash", ["./bootstrap.sh"]);
  const tokens = readLandscapeTokens();
  if (!(await hasSeedData(tokens))) {
    run("bash", ["./seed.sh"]);
  }
  if (!(await isLandscapeReady())) {
    throw new Error("scenario-1 landscape did not become ready after bring-up");
  }
  return wasUp ? "reused" : "started";
}

/**
 * The scenario's `.env` (image tags + host ports) is gitignored, so a fresh worktree/CI
 * clone lacks it — yet `bootstrap.sh`/`seed.sh` `source .env`. Write the known values
 * (matching the committed `docker-compose.yml` defaults) when it is absent, so auto
 * bring-up is self-contained.
 */
function ensureScenarioEnvFile(): void {
  const envFile = `${SCENARIO_DIR}/.env`;
  if (existsSync(envFile)) {
    return;
  }
  writeFileSync(
    envFile,
    [
      "GITEA_TAG=1.25.5",
      "VIKUNJA_TAG=2.3.0",
      `GITEA_PORT=${String(GITEA_PORT)}`,
      `VIKUNJA_PORT=${String(VIKUNJA_PORT)}`,
      "",
    ].join("\n"),
  );
}

/** Tear the landscape down (`docker compose down -v`) — only for a landscape this run started. */
export function teardownScenario1Landscape(): void {
  execFileSync("docker", ["compose", "down", "-v"], {
    cwd: SCENARIO_DIR,
    stdio: "inherit",
    timeout: 120_000,
  });
}
