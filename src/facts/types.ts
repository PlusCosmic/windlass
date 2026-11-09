/** A single line in a diff, numbered in the file it belongs to (head for added, base for removed). */
export interface DiffLine {
  line: number;
  text: string;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface ChangedFile {
  /** Path on head; for deleted files, the path on base. */
  path: string;
  /** Path on base, when it differs from `path` (renames and copies). */
  previousPath?: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  addedLines: DiffLine[];
  removedLines: DiffLine[];
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export type CheckStatus = "queued" | "in_progress" | "completed";

export type CheckConclusion =
  "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale";

/** One CI check run, mirroring the shape of a GitHub check run. */
export interface CheckRun {
  name: string;
  status: CheckStatus;
  conclusion?: CheckConclusion | null;
}

export interface CiStatus {
  checks: CheckRun[];
}

/** Everything the engine needs to know about a pull request. */
export interface PullRequestInput {
  baseSha: string;
  headSha: string;
  /** The PR description. Only the fenced `windlass` block is ever read from it. */
  body: string;
  /** Unified diff of base...head, as produced by `git diff` or the GitHub API. */
  diff: string;
  /** CI status for the head commit; absent when it hasn't been collected. */
  ci?: CiStatus;
}

/**
 * Facts computed from the pull request. Gates and evaluators see these, never
 * the PR description or commit messages.
 */
export interface Facts {
  baseSha: string;
  headSha: string;
  diff: string;
  files: ChangedFile[];
  stats: DiffStats;
  ci: CiStatus | null;
}
