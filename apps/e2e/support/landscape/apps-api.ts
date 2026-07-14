import {
  GITEA_BASE_URL,
  GITEA_OWNER,
  GITEA_REPO,
  VIKUNJA_BASE_URL,
  type LandscapeTokens,
} from "./env.js";

/**
 * Thin REST clients for the **real** Gitea/Vikunja containers — how the SU-6 journey
 * injects the source change (a Gitea issue edit) and asserts the outbound write landed
 * (a Vikunja task update) directly against each app's own API, using the throwaway
 * `.tokens.env` tokens. This is deliberately the apps' *real* API surface: the whole
 * point of the capstone is that only the LLM/mapping is replayed — the apps are live.
 */

/** The subset of a Gitea issue the journey reads/asserts on. */
export interface GiteaIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly updated_at: string;
}

/** The subset of a Vikunja task the journey reads/asserts on. */
export interface VikunjaTask {
  readonly id: number;
  readonly title: string;
  readonly description: string;
  readonly done: boolean;
  readonly updated: string;
}

export class GiteaClient {
  readonly #token: string;

  public constructor(token: string) {
    this.#token = token;
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${GITEA_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `token ${this.#token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`Gitea ${method} ${path} → HTTP ${String(response.status)}`);
    }
    return response.json();
  }

  /** The alice/phoenix issue with `title`, or `undefined` — the identity-key lookup the journey mirrors. */
  public async findIssueByTitle(title: string): Promise<GiteaIssue | undefined> {
    const issues = (await this.#json(
      "GET",
      `/repos/${GITEA_OWNER}/${GITEA_REPO}/issues?state=all&limit=50`,
    )) as GiteaIssue[];
    return issues.find((issue) => issue.title === title);
  }

  /** Read one issue by its per-repo `number` (to capture `updated_at`/`body` before/after a poll). */
  public async getIssue(issueNumber: number): Promise<GiteaIssue> {
    return (await this.#json(
      "GET",
      `/repos/${GITEA_OWNER}/${GITEA_REPO}/issues/${String(issueNumber)}`,
    )) as GiteaIssue;
  }

  /** Edit an issue's `body` (the source change the Gitea→Vikunja rule must propagate). */
  public async setIssueBody(issueNumber: number, body: string): Promise<GiteaIssue> {
    return (await this.#json(
      "PATCH",
      `/repos/${GITEA_OWNER}/${GITEA_REPO}/issues/${String(issueNumber)}`,
      { body },
    )) as GiteaIssue;
  }
}

export class VikunjaClient {
  readonly #token: string;

  public constructor(token: string) {
    this.#token = token;
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${VIKUNJA_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`Vikunja ${method} ${path} → HTTP ${String(response.status)}`);
    }
    return response.json();
  }

  /** Every task (the global, param-free collection read the mediator also polls). */
  public async listTasks(): Promise<VikunjaTask[]> {
    return (await this.#json("GET", "/tasks")) as VikunjaTask[];
  }

  /** Read one task by id (to assert the outbound write landed). */
  public async getTask(taskId: number): Promise<VikunjaTask> {
    return (await this.#json("GET", `/tasks/${String(taskId)}`)) as VikunjaTask;
  }

  /** The task with `title`, or `undefined`. */
  public async findTaskByTitle(title: string): Promise<VikunjaTask | undefined> {
    const tasks = await this.listTasks();
    return tasks.find((task) => task.title === title);
  }

  /** Set a task's `description` (used to normalize a known baseline before enabling). */
  public async setTaskDescription(taskId: number, description: string): Promise<VikunjaTask> {
    return (await this.#json("POST", `/tasks/${String(taskId)}`, { description })) as VikunjaTask;
  }
}

/** Build both clients from the landscape tokens. */
export function landscapeClients(tokens: LandscapeTokens): {
  readonly gitea: GiteaClient;
  readonly vikunja: VikunjaClient;
} {
  return { gitea: new GiteaClient(tokens.gitea), vikunja: new VikunjaClient(tokens.vikunja) };
}
