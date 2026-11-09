import type { getOctokit } from "@actions/github";
import type { CheckRun } from "../../src/index.js";
import { COMMENT_MARKER } from "./comment.js";
import type { Comment, GitHubPort, PullRequestData } from "./port.js";

type Octokit = ReturnType<typeof getOctokit>;

export interface OctokitPortOptions {
  owner: string;
  repo: string;
  /** This workflow run's id; its own check runs are never counted as CI. */
  runId: number;
  /** Check names to leave out of CI, such as the Windlass job's own name. */
  ignoreChecks: readonly string[];
  /** Login Windlass comments as; only its comments are ever edited. */
  commentAuthor: string;
}

export class OctokitPort implements GitHubPort {
  constructor(
    private readonly octokit: Octokit,
    private readonly options: OctokitPortOptions,
  ) {}

  private get repo() {
    return { owner: this.options.owner, repo: this.options.repo };
  }

  async getPullRequest(number: number): Promise<PullRequestData> {
    const { data } = await this.octokit.rest.pulls.get({ ...this.repo, pull_number: number });
    return {
      number: data.number,
      state: data.state === "open" ? "open" : "closed",
      draft: data.draft ?? false,
      body: data.body ?? "",
      baseRef: data.base.ref,
      baseSha: data.base.sha,
      headSha: data.head.sha,
    };
  }

  async findOpenPullRequests(sha: string): Promise<number[]> {
    const { data } = await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...this.repo,
      commit_sha: sha,
    });
    return data.filter((pr) => pr.state === "open" && pr.head.sha === sha).map((pr) => pr.number);
  }

  async getFile(path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({ ...this.repo, path, ref });
      if (Array.isArray(data) || data.type !== "file") throw new Error(`${path} on ${ref} is not a file`);
      if (!("content" in data) || data.encoding !== "base64") throw new Error(`${path} on ${ref} could not be read`);
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
  }

  async getDiff(number: number): Promise<string> {
    const { data } = await this.octokit.rest.pulls.get({
      ...this.repo,
      pull_number: number,
      mediaType: { format: "diff" },
    });
    // With the diff media type the API returns the raw diff text rather than JSON.
    if (typeof data !== "string") throw new Error("expected the pull request diff as text");
    return data;
  }

  async getChecks(sha: string): Promise<CheckRun[]> {
    const ignored = new Set(this.options.ignoreChecks);
    const ownRun = `/actions/runs/${this.options.runId}/`;

    const runs = await this.octokit.paginate(this.octokit.rest.checks.listForRef, {
      ...this.repo,
      ref: sha,
      filter: "latest",
      per_page: 100,
    });
    const checks: CheckRun[] = runs
      .filter((run) => !ignored.has(run.name) && !(run.details_url ?? "").includes(ownRun))
      .map((run) => ({
        name: run.name,
        status: run.status === "completed" ? "completed" : run.status === "queued" ? "queued" : "in_progress",
        conclusion: run.conclusion ?? null,
      }));

    // Commit statuses (the older API some CI services still use) count too.
    const { data: combined } = await this.octokit.rest.repos.getCombinedStatusForRef({
      ...this.repo,
      ref: sha,
      per_page: 100,
    });
    for (const s of combined.statuses) {
      if (ignored.has(s.context)) continue;
      checks.push(
        s.state === "pending"
          ? { name: s.context, status: "in_progress", conclusion: null }
          : { name: s.context, status: "completed", conclusion: s.state === "success" ? "success" : "failure" },
      );
    }
    return checks;
  }

  async findComment(number: number): Promise<Comment | null> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      ...this.repo,
      issue_number: number,
      per_page: 100,
    });
    // Only Windlass's own comments: anyone can post a comment that starts with the marker.
    const ours = comments.find(
      (c) => c.user?.login === this.options.commentAuthor && (c.body ?? "").startsWith(COMMENT_MARKER),
    );
    return ours ? { id: ours.id, body: ours.body ?? "" } : null;
  }

  async createComment(number: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ ...this.repo, issue_number: number, body });
  }

  async updateComment(id: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({ ...this.repo, comment_id: id, body });
  }

  async getLabels(number: number): Promise<string[]> {
    const labels = await this.octokit.paginate(this.octokit.rest.issues.listLabelsOnIssue, {
      ...this.repo,
      issue_number: number,
      per_page: 100,
    });
    return labels.map((label) => label.name);
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    // GitHub creates labels that don't exist yet.
    await this.octokit.rest.issues.addLabels({ ...this.repo, issue_number: number, labels });
  }

  async removeLabel(number: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({ ...this.repo, issue_number: number, name: label });
    } catch (error) {
      if (status(error) !== 404) throw error;
    }
  }
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}
