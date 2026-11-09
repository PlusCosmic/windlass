import type { CheckRun } from "../../src/index.js";

export interface PullRequestData {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  /** The PR description; only the `windlass` block is ever read from it. */
  body: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

export interface Comment {
  id: number;
  body: string;
}

/** Everything the Action needs from GitHub, so the logic can be tested without it. */
export interface GitHubPort {
  getPullRequest(number: number): Promise<PullRequestData>;
  /** Open PRs whose head is `sha`. */
  findOpenPullRequests(sha: string): Promise<number[]>;
  /** File contents at `ref`, or null when the file doesn't exist. */
  getFile(path: string, ref: string): Promise<string | null>;
  /** Unified diff of the PR (base...head). */
  getDiff(number: number): Promise<string>;
  /** CI checks and commit statuses for `sha`, excluding Windlass's own. */
  getChecks(sha: string): Promise<CheckRun[]>;
  /** The comment Windlass posted on the PR earlier, if any. */
  findComment(number: number): Promise<Comment | null>;
  createComment(number: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
  getLabels(number: number): Promise<string[]>;
  addLabels(number: number, labels: string[]): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
}
