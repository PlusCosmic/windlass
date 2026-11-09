import { describe, expect, it } from "vitest";
import type { CheckRun } from "../../src/index.js";
import { COMMENT_MARKER, commentSha } from "./comment.js";
import type { Comment, GitHubPort, PullRequestData } from "./port.js";
import { evaluatePullRequest, resolvePullRequests } from "./run.js";

const POLICY = `
policy: v1
defaults:
  always: [no_new_skips, ci_green]
categories:
  docs_only:
    gates:
      - paths_only: ["**/*.md"]
    outcome: merge
`;

const DOCS_DIFF = ["--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-old", "+new"].join("\n");
const green: CheckRun[] = [{ name: "test", status: "completed", conclusion: "success" }];

/** In-memory GitHub with one repo. */
class FakeGitHub implements GitHubPort {
  pr: PullRequestData = {
    number: 7,
    state: "open",
    draft: false,
    body: "```windlass\ncategory: docs_only\n```",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  files = new Map<string, string>([["main:.windlass/policy.yaml", POLICY]]);
  diff = DOCS_DIFF;
  checks: CheckRun[] = green;
  comments: Comment[] = [];
  labels: string[] = [];
  /** Head SHAs returned by successive getPullRequest calls, to simulate pushes. */
  heads: string[] = [];
  fileRefs: string[] = [];

  async getPullRequest() {
    return { ...this.pr, headSha: this.heads.shift() ?? this.pr.headSha };
  }
  async findOpenPullRequests(sha: string) {
    return sha === this.pr.headSha ? [this.pr.number] : [];
  }
  async getFile(path: string, ref: string) {
    this.fileRefs.push(ref);
    return this.files.get(`${ref}:${path}`) ?? null;
  }
  async getDiff() {
    return this.diff;
  }
  async getChecks() {
    return this.checks;
  }
  async findComment() {
    return this.comments.find((c) => c.body.startsWith(COMMENT_MARKER)) ?? null;
  }
  async createComment(_: number, body: string) {
    this.comments.push({ id: this.comments.length + 1, body });
  }
  async updateComment(id: number, body: string) {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) throw new Error(`no comment ${id}`);
    comment.body = body;
  }
  async getLabels() {
    return [...this.labels];
  }
  async addLabels(_: number, labels: string[]) {
    this.labels.push(...labels);
  }
  async removeLabel(_: number, label: string) {
    this.labels = this.labels.filter((l) => l !== label);
  }
}

const config = { policyPath: ".windlass/policy.yaml" };

describe("evaluatePullRequest", () => {
  it("comments and labels a would-merge decision without merging", async () => {
    const gh = new FakeGitHub();
    const result = await evaluatePullRequest(gh, 7, config);
    expect(result).toMatchObject({ status: "decided", decision: { outcome: "merge" } });
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]?.body).toContain("Would merge (shadow mode");
    expect(commentSha(gh.comments[0]!.body)).toBe(gh.pr.headSha);
    expect(gh.labels).toEqual(["windlass/would-merge"]);
  });

  it("reads the policy from the base branch", async () => {
    const gh = new FakeGitHub();
    gh.files.set(`feature:.windlass/policy.yaml`, "policy: v1\ncategories: {}");
    await evaluatePullRequest(gh, 7, config);
    expect(gh.fileRefs).toEqual(["main"]);
  });

  it("updates its comment and swaps labels on a new decision", async () => {
    const gh = new FakeGitHub();
    await evaluatePullRequest(gh, 7, config);
    gh.pr.headSha = "c".repeat(40);
    gh.diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", '+it.only("x", () => {});'].join("\n");
    const result = await evaluatePullRequest(gh, 7, config);
    expect(result).toMatchObject({ decision: { outcome: "block" } });
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]?.body).toContain("Blocked");
    expect(gh.labels).toEqual(["windlass/block"]);
  });

  it("escalates when the base branch has no policy", async () => {
    const gh = new FakeGitHub();
    gh.files.clear();
    const result = await evaluatePullRequest(gh, 7, config);
    expect(result).toMatchObject({ decision: { outcome: "escalate" } });
    expect(gh.comments[0]?.body).toContain("no policy file at .windlass/policy.yaml on main");
    expect(gh.labels).toEqual(["windlass/escalate"]);
  });

  it("posts nothing while CI is pending", async () => {
    const gh = new FakeGitHub();
    gh.checks = [{ name: "test", status: "in_progress" }];
    const result = await evaluatePullRequest(gh, 7, config);
    expect(result.status).toBe("pending");
    expect(gh.comments).toEqual([]);
    expect(gh.labels).toEqual([]);
  });

  it("marks an earlier decision stale while CI runs for a new head", async () => {
    const gh = new FakeGitHub();
    gh.labels = ["windlass/would-merge", "bug"];
    await evaluatePullRequest(gh, 7, config);
    gh.pr.headSha = "d".repeat(40);
    gh.checks = [{ name: "test", status: "queued" }];
    await evaluatePullRequest(gh, 7, config);
    expect(gh.comments[0]?.body).toContain("Waiting on CI");
    expect(commentSha(gh.comments[0]!.body)).toBe("d".repeat(40));
    expect(gh.labels).toEqual(["bug"]);
  });

  it("skips closed and draft PRs", async () => {
    const gh = new FakeGitHub();
    gh.pr.draft = true;
    expect(await evaluatePullRequest(gh, 7, config)).toMatchObject({ status: "skipped" });
    gh.pr.draft = false;
    gh.pr.state = "closed";
    expect(await evaluatePullRequest(gh, 7, config)).toMatchObject({ status: "skipped" });
    expect(gh.comments).toEqual([]);
  });

  it("skips when the head moves during evaluation", async () => {
    const gh = new FakeGitHub();
    gh.heads = [gh.pr.headSha, "e".repeat(40)];
    expect(await evaluatePullRequest(gh, 7, config)).toMatchObject({ status: "skipped" });
    expect(gh.comments).toEqual([]);
  });
});

describe("resolvePullRequests", () => {
  const gh = new FakeGitHub();

  it("uses the PR from a pull_request event", async () => {
    expect(await resolvePullRequests("pull_request", { pull_request: { number: 3 } }, gh, null)).toEqual([3]);
  });

  it("uses a workflow run's PRs, or looks them up by head SHA", async () => {
    const listed = { workflow_run: { head_sha: "x", pull_requests: [{ number: 4 }, { number: 5 }] } };
    expect(await resolvePullRequests("workflow_run", listed, gh, null)).toEqual([4, 5]);
    const unlisted = { workflow_run: { head_sha: gh.pr.headSha, pull_requests: [] } };
    expect(await resolvePullRequests("workflow_run", unlisted, gh, null)).toEqual([7]);
  });

  it("prefers the manual input and requires it for workflow_dispatch", async () => {
    expect(await resolvePullRequests("workflow_dispatch", {}, gh, 9)).toEqual([9]);
    await expect(resolvePullRequests("workflow_dispatch", {}, gh, null)).rejects.toThrow(/pull-request/);
  });

  it("ignores other events", async () => {
    expect(await resolvePullRequests("push", {}, gh, null)).toEqual([]);
  });
});
