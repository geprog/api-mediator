/**
 * Thin REST client for the **real** Vikunja container the CU-5 capstone resolves
 * adapter calls against — how a journey seeds/inspects backend state directly (find a
 * project id to write into, assert an adapter write landed, delete a created task) via
 * Vikunja's *own* API surface, using the throwaway `.tokens.env` token. Only the
 * mediator's mapping is fixtured; the app is live.
 */

/** A Vikunja project (the "list" a todo is created into). */
export interface VikunjaProject {
  readonly id: number;
  readonly title: string;
}

/** The subset of a Vikunja task the journey reads/asserts on. */
export interface VikunjaTask {
  readonly id: number;
  readonly title: string;
  readonly description: string;
  readonly done: boolean;
  readonly due_date?: string;
  readonly updated?: string;
}

/** A REST client for one live Vikunja container (Bearer `tk_` token). */
export class VikunjaClient {
  readonly #baseUrl: string;
  readonly #token: string;

  /** @param baseUrl e.g. `http://localhost:13400/api/v1` */
  public constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
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

  /** Every task (the global, param-free collection the mediator's `listTodos` binding reads). */
  public async listTasks(): Promise<VikunjaTask[]> {
    return (await this.#json("GET", "/tasks")) as VikunjaTask[];
  }

  public async getTask(taskId: number): Promise<VikunjaTask> {
    return (await this.#json("GET", `/tasks/${String(taskId)}`)) as VikunjaTask;
  }

  /** Tasks whose `title` equals `title` (a created-task duplicate check for WR-3). */
  public async findTasksByTitle(title: string): Promise<VikunjaTask[]> {
    return (await this.listTasks()).filter((task) => task.title === title);
  }

  /** The first project titled `title`, or `undefined` — the write's real target list id. */
  public async findProjectByTitle(title: string): Promise<VikunjaProject | undefined> {
    const projects = (await this.#json("GET", "/projects")) as VikunjaProject[];
    return projects.find((project) => project.title === title);
  }

  /** Delete a task (cleanup of a task an adapter write created). */
  public async deleteTask(taskId: number): Promise<void> {
    await this.#json("DELETE", `/tasks/${String(taskId)}`);
  }
}
