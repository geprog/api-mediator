import { GITEA_BASE_URL, VIKUNJA_BASE_URL, type LandscapeTokens } from "./env.js";

/**
 * **Multi-container** REST clients for the real Gitea/Vikunja containers — the Slice-D
 * capstone's hands on the landscape. Where {@link ./apps-api.ts} drives the one seeded
 * `alice/phoenix` container, this drives *many*: it creates, enumerates and deletes the
 * repositories/projects that ARE the scopes, and injects/reads records **per container**.
 *
 * Every repository is created under the **token owner's** own account (`POST /user/repos`),
 * so `GET /user/repos` — the container list the mediator enumerates — returns exactly the
 * containers this journey owns and nothing else. That is what makes an enumeration
 * assertion ("the mediator listed the containers and polled each") deterministic on a
 * landscape that other suites also use.
 */

/** A Gitea repository (a source container). */
export interface GiteaRepo {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly owner: { readonly login: string };
}

/** A Vikunja project (a target container). */
export interface VikunjaProject {
  readonly id: number;
  readonly title: string;
}

/** The subset of a Gitea issue the capstone reads/asserts on. */
export interface ScopedGiteaIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly updated_at: string;
  readonly repository: { readonly name: string; readonly owner: string };
}

/** The subset of a Vikunja task the capstone reads/asserts on. */
export interface ScopedVikunjaTask {
  readonly id: number;
  readonly title: string;
  readonly description: string;
  readonly done: boolean;
  readonly project_id: number;
  readonly updated: string;
}

async function request(
  baseUrl: string,
  authorization: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path} → HTTP ${String(response.status)}: ${await response.text()}`,
    );
  }
  if (response.status === 204) {
    return undefined;
  }
  return response.json();
}

/** Gitea: the **source** app, whose repositories are the source containers. */
export class ScopedGiteaClient {
  readonly #auth: string;

  public constructor(token: string) {
    this.#auth = `token ${token}`;
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    return request(GITEA_BASE_URL, this.#auth, method, path, body);
  }

  /** The authenticated user's login — the `{owner}` every container of this journey uses. */
  public async currentUserLogin(): Promise<string> {
    const user = (await this.#json("GET", "/user")) as { login: string };
    return user.login;
  }

  /**
   * The container list **the mediator itself enumerates** (`GET /user/repos`), read here so
   * a test can assert the landscape's real container set independently of the mediator.
   */
  public async listRepos(): Promise<GiteaRepo[]> {
    return (await this.#json("GET", "/user/repos")) as GiteaRepo[];
  }

  /** Create a source container. */
  public async createRepo(name: string): Promise<GiteaRepo> {
    return (await this.#json("POST", "/user/repos", { name, auto_init: false })) as GiteaRepo;
  }

  /** Delete a source container (cleanup). Never throws — cleanup must not mask a failure. */
  public async deleteRepoQuietly(owner: string, repo: string): Promise<void> {
    try {
      await this.#json("DELETE", `/repos/${owner}/${repo}`);
    } catch {
      // Already gone / not ours — cleanup is best-effort by design.
    }
  }

  /** Every issue in one container (`state=all`), the scoped read the mediator also polls. */
  public async listIssues(owner: string, repo: string): Promise<ScopedGiteaIssue[]> {
    return (await this.#json(
      "GET",
      `/repos/${owner}/${repo}/issues?state=all&limit=50`,
    )) as ScopedGiteaIssue[];
  }

  /** Create an issue **in a specific container** — the source change a poll must propagate. */
  public async createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
  ): Promise<ScopedGiteaIssue> {
    return (await this.#json("POST", `/repos/${owner}/${repo}/issues`, {
      title,
      body,
    })) as ScopedGiteaIssue;
  }

  public async getIssue(owner: string, repo: string, index: number): Promise<ScopedGiteaIssue> {
    return (await this.#json(
      "GET",
      `/repos/${owner}/${repo}/issues/${String(index)}`,
    )) as ScopedGiteaIssue;
  }

  public async findIssueByTitle(
    owner: string,
    repo: string,
    title: string,
  ): Promise<ScopedGiteaIssue | undefined> {
    const issues = await this.listIssues(owner, repo);
    return issues.find((issue) => issue.title === title);
  }
}

/** Vikunja: the **target** app, whose projects are the target containers. */
export class ScopedVikunjaClient {
  readonly #auth: string;

  public constructor(token: string) {
    this.#auth = `Bearer ${token}`;
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    return request(VIKUNJA_BASE_URL, this.#auth, method, path, body);
  }

  /** The container list the mediator enumerates on the target side (`GET /projects`). */
  public async listProjects(): Promise<VikunjaProject[]> {
    return (await this.#json("GET", "/projects")) as VikunjaProject[];
  }

  /** Create a target container (Vikunja creates with PUT). */
  public async createProject(title: string): Promise<VikunjaProject> {
    return (await this.#json("PUT", "/projects", { title })) as VikunjaProject;
  }

  /** Delete a target container (cleanup). Best-effort, never throws. */
  public async deleteProjectQuietly(projectId: number): Promise<void> {
    try {
      await this.#json("DELETE", `/projects/${String(projectId)}`);
    } catch {
      // Already gone — cleanup is best-effort by design.
    }
  }

  /**
   * The tasks of ONE project — the container-scoped read that makes "it landed in project A
   * and NOT in project B" a direct, per-container assertion rather than a global filter.
   */
  public async listProjectTasks(projectId: number): Promise<ScopedVikunjaTask[]> {
    return (await this.#json("GET", `/projects/${String(projectId)}/tasks`)) as ScopedVikunjaTask[];
  }

  public async findProjectTaskByTitle(
    projectId: number,
    title: string,
  ): Promise<ScopedVikunjaTask | undefined> {
    const tasks = await this.listProjectTasks(projectId);
    return tasks.find((task) => task.title === title);
  }

  /** Create a task **in a specific project** — a pre-existing counterpart for backfill to link. */
  public async createTaskInProject(
    projectId: number,
    title: string,
    description: string,
  ): Promise<ScopedVikunjaTask> {
    return (await this.#json("PUT", `/projects/${String(projectId)}/tasks`, {
      title,
      description,
    })) as ScopedVikunjaTask;
  }

  public async getTask(taskId: number): Promise<ScopedVikunjaTask> {
    return (await this.#json("GET", `/tasks/${String(taskId)}`)) as ScopedVikunjaTask;
  }

  /** Edit a task's description (Vikunja updates with POST) — the counterpart-direction change. */
  public async setTaskDescription(taskId: number, description: string): Promise<ScopedVikunjaTask> {
    return (await this.#json("POST", `/tasks/${String(taskId)}`, {
      description,
    })) as ScopedVikunjaTask;
  }
}

/** Build both multi-container clients from the landscape tokens. */
export function scopedLandscapeClients(tokens: LandscapeTokens): {
  readonly gitea: ScopedGiteaClient;
  readonly vikunja: ScopedVikunjaClient;
} {
  return {
    gitea: new ScopedGiteaClient(tokens.gitea),
    vikunja: new ScopedVikunjaClient(tokens.vikunja),
  };
}
