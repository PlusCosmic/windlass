import type { CheckRun } from "../../src/index.js";
import { COMMENT_MARKER } from "../../github/comment.js";
import type { Comment, PullRequestData } from "../../github/port.js";
import type { AppGitHubPort, CheckReport, ProposedFile } from "./port.js";
import type { GitHubAccess } from "./service.js";

export const POLICY = `# The test policy.
policy: v1
defaults:
  always: [no_new_skips, ci_green]
categories:
  docs_only:
    gates:
      - paths_only: ["**/*.md"]
    outcome: merge
`;

export const DOCS_DIFF = ["--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-old", "+new"].join("\n");
export const SRC_DIFF = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
export const GREEN: CheckRun[] = [{ name: "test", status: "completed", conclusion: "success" }];

export function pull(number: number, overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    number,
    state: "open",
    draft: false,
    merged: false,
    title: `PR ${number}`,
    author: "agent",
    body: "```windlass\ncategory: docs_only\n```",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: String(number).repeat(40).slice(0, 40),
    ...overrides,
  };
}

/** One repository on an in-memory GitHub. */
export class FakeGitHub implements AppGitHubPort {
  pulls = new Map<number, PullRequestData>();
  diffs = new Map<number, string>();
  policy: string | null = POLICY;
  checks: CheckRun[] = GREEN;
  comments = new Map<number, Comment>();
  labels = new Map<number, string[]>();
  reports: { sha: string; check: CheckReport }[] = [];
  proposals: ProposedFile[] = [];

  add(pr: PullRequestData, diff = DOCS_DIFF): this {
    this.pulls.set(pr.number, pr);
    this.diffs.set(pr.number, diff);
    return this;
  }

  async getPullRequest(number: number) {
    const pr = this.pulls.get(number);
    if (!pr) throw new Error(`no pull request ${number}`);
    return { ...pr };
  }
  async findOpenPullRequests(sha: string) {
    return [...this.pulls.values()].filter((pr) => pr.state === "open" && pr.headSha === sha).map((pr) => pr.number);
  }
  async getFile() {
    return this.policy;
  }
  async getDiff(number: number) {
    return this.diffs.get(number) ?? "";
  }
  async getChecks() {
    return this.checks;
  }
  async findComment(number: number) {
    const comment = this.comments.get(number);
    return comment?.body.startsWith(COMMENT_MARKER) ? comment : null;
  }
  async createComment(number: number, body: string) {
    this.comments.set(number, { id: number, body });
  }
  async updateComment(id: number, body: string) {
    this.comments.set(id, { id, body });
  }
  async getLabels(number: number) {
    return [...(this.labels.get(number) ?? [])];
  }
  async addLabels(number: number, labels: string[]) {
    this.labels.set(number, [...(this.labels.get(number) ?? []), ...labels]);
  }
  async removeLabel(number: number, label: string) {
    this.labels.set(
      number,
      (this.labels.get(number) ?? []).filter((l) => l !== label),
    );
  }
  async getDefaultBranch() {
    return "main";
  }
  async listRecentPullRequests(limit: number) {
    return [...this.pulls.keys()].sort((a, b) => b - a).slice(0, limit);
  }
  async reportCheck(sha: string, check: CheckReport) {
    this.reports.push({ sha, check });
  }
  async proposeFile(file: ProposedFile) {
    this.proposals.push(file);
    return "https://github.com/acme/app/pull/99";
  }
}

export function accessTo(github: FakeGitHub | null, write = true): GitHubAccess {
  return { forRepo: async () => (github ? { port: github, write } : null) };
}
