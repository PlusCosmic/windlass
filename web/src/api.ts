import type { EvaluatorCatalog, GateInfo, Simulation } from "../../app/src/service";

export type { EvaluatorCatalog, GateInfo, SimulatedPull, Simulation } from "../../app/src/service";

/** Whether a runner is there to answer evaluators, and how many questions it has waiting. */
export type RunnerStatus = Simulation["evaluators"];

export interface Me {
  login: string;
  mode: "app" | "dev";
  policyPath: string;
  gates: GateInfo[];
  /** The built-in questions an evaluator can ask, and what a question can refer to. */
  evaluators: EvaluatorCatalog;
}

export interface RepoSummary {
  owner: string;
  name: string;
  /** Whether Windlass can reach it on GitHub as the App. */
  connected: boolean;
  pulls: number;
}

/** A simulation, plus the policy on the default branch it was compared against. */
export type SimulationResponse = Simulation & { source: string | null };

/** The API said no. `status` 401 means the session is missing or over. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    ...(signal && { signal }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : "";
    throw new ApiError(response.status, message);
  }
  return data as T;
}

const repoPath = (repo: string) => `/api/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

export const api = {
  me: () => call<Me>("/api/me"),
  repos: () => call<RepoSummary[]>("/api/repos"),
  simulate: (repo: string, policy: string | null, signal?: AbortSignal) =>
    call<SimulationResponse>(`${repoPath(repo)}/simulate`, { policy }, signal),
  /** Asks a runner every evaluator question the stored pull requests have no answer for. Answers show on later simulations. */
  evaluate: (repo: string, policy: string | null) => call<{ queued: number }>(`${repoPath(repo)}/evaluate`, { policy }),
  importPulls: (repo: string, limit: number) => call<{ imported: number }>(`${repoPath(repo)}/import`, { limit }),
  propose: (repo: string, policy: string) => call<{ url: string }>(`${repoPath(repo)}/propose`, { policy }),
  signOut: () => call<{ ok: true }>("/auth/logout", {}),
};
