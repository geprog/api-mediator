import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Shared bring-up primitives for the **CU-5 adapter capstone** landscapes
 * (scenario-3 Vikunja, scenario-4 Gitea+Forgejo+Vikunja). These concern the
 * *containers* the mediator resolves adapter calls against; the mediator itself is
 * the ordinary e2e backend the Playwright `webServer` boots.
 *
 * Every adapter journey is **landscape-gated**: if Docker or the landscape is
 * unreachable the spec skips (never fails), so `pnpm --filter @mediator/e2e test:e2e`
 * on a box with only the compose Postgres still passes. Bring a landscape up manually
 * per its README (`docker compose up -d --wait && ./bootstrap.sh && ./seed.sh`), or
 * let each scenario's `ensure*Landscape` do it.
 */

/** `reused` = it was already up (do NOT tear down); `started` = this run brought it up. */
export type LandscapeBringUp = "reused" | "started" | "unavailable";

/** Parse a `KEY=value` env file into a record (ignoring comments/blank lines). */
export function parseEnvFile(contents: string): Record<string, string> {
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

/** Read one required token from a scenario's gitignored `.tokens.env`. */
export function readToken(tokensFile: string, key: string): string {
  const parsed = parseEnvFile(readFileSync(tokensFile, "utf8"));
  const value = parsed[key];
  if (value === undefined || value === "") {
    throw new Error(`${tokensFile} is missing ${key} — run the scenario's bootstrap.sh`);
  }
  return value;
}

/** True when `url` answers below 500 within `timeoutMs` (a readiness probe; allows 4xx). */
export async function probe(url: string, timeoutMs = 2_000): Promise<boolean> {
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

/** A 2xx probe carrying a Bearer token (distinct from {@link probe}, which allows 4xx). */
export async function probeAuthed(url: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    return response.ok;
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

/** Run a command in a scenario directory, inheriting stdio (bring-up is noisy on purpose). */
export function runIn(cwd: string, command: string, args: string[]): void {
  execFileSync(command, args, { cwd, stdio: "inherit", timeout: 300_000 });
}

/**
 * Write a scenario's gitignored `.env` (image tags + host ports) with known values
 * when it is absent, so a fresh worktree/CI clone can auto-bring-up the landscape —
 * `bootstrap.sh`/`seed.sh` `source .env`. The values must match the committed
 * `docker-compose.yml` defaults.
 */
export function ensureEnvFile(scenarioDir: string, lines: readonly string[]): void {
  const envFile = `${scenarioDir}/.env`;
  if (existsSync(envFile)) {
    return;
  }
  writeFileSync(envFile, [...lines, ""].join("\n"));
}

/** `docker compose up -d --wait` in a scenario directory. */
export function composeUp(scenarioDir: string): void {
  runIn(scenarioDir, "docker", ["compose", "up", "-d", "--wait"]);
}

/** `docker compose down -v` — only for a landscape this run started. */
export function composeDown(scenarioDir: string): void {
  execFileSync("docker", ["compose", "down", "-v"], {
    cwd: scenarioDir,
    stdio: "inherit",
    timeout: 120_000,
  });
}
