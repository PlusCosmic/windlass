import type { DecisionRecord } from "../../src/index.js";
import { OctokitPort } from "../../github/octokit.js";
import type { GitHubPort } from "../../github/port.js";

/** A check run Windlass reports on a commit. */
export interface CheckReport {
  status: "in_progress" | "completed";
  /** Set when completed. */
  conclusion?: "success" | "neutral";
  title: string;
  summary: string;
  /** Where "Details" leads: the PR in the Windlass editor. */
  detailsUrl?: string;
}

export interface ProposedFile {
  path: string;
  content: string;
  branch: string;
  title: string;
  body: string;
}

/** What the App needs from GitHub beyond judging one PR. */
export interface AppGitHubPort extends GitHubPort {
  getDefaultBranch(): Promise<string>;
  /** Numbers of the most recently updated PRs, open or not. */
  listRecentPullRequests(limit: number): Promise<number[]>;
  reportCheck(sha: string, check: CheckReport): Promise<void>;
  /** Opens a PR against the default branch that changes one file. Returns its URL. */
  proposeFile(file: ProposedFile): Promise<string>;
}

export const CHECK_NAME = "Windlass";

/**
 * The check run for a decision. Shadow mode: Windlass enforces nothing, so an
 * escalation or a block is reported as neutral, never as a failing check that
 * could hold a PR up.
 */
export function checkFor(decision: DecisionRecord, detailsUrl?: string): CheckReport {
  const details = detailsUrl === undefined ? {} : { detailsUrl };
  if (decision.outcome === "pending") {
    return {
      status: "in_progress",
      title: "Waiting on CI",
      summary: "Windlass decides once CI has finished.",
      ...details,
    };
  }
  const titles = { merge: "Would merge", escalate: "Needs human review", block: "Blocked" } as const;
  const count = decision.reasons.length;
  return {
    status: "completed",
    conclusion: decision.outcome === "merge" ? "success" : "neutral",
    title: `${titles[decision.outcome]} (shadow mode)`,
    // The reasons can quote attacker-controlled text; they are in Windlass's comment, escaped. Counts only here.
    summary:
      decision.outcome === "merge"
        ? "Every gate passed. Shadow mode: nothing was merged."
        : `${count} reason${count === 1 ? "" : "s"}; see Windlass's comment on the pull request.`,
    ...details,
  };
}

export class AppOctokitPort extends OctokitPort implements AppGitHubPort {
  async getDefaultBranch(): Promise<string> {
    const { data } = await this.octokit.rest.repos.get(this.repo);
    return data.default_branch;
  }

  async listRecentPullRequests(limit: number): Promise<number[]> {
    const { data } = await this.octokit.rest.pulls.list({
      ...this.repo,
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: Math.min(Math.max(limit, 1), 100),
    });
    return data.map((pr) => pr.number);
  }

  async reportCheck(sha: string, check: CheckReport): Promise<void> {
    await this.octokit.rest.checks.create({
      ...this.repo,
      name: CHECK_NAME,
      head_sha: sha,
      status: check.status,
      ...(check.conclusion !== undefined && { conclusion: check.conclusion }),
      ...(check.detailsUrl !== undefined && { details_url: check.detailsUrl }),
      output: { title: check.title, summary: check.summary },
    });
  }

  async proposeFile(file: ProposedFile): Promise<string> {
    const base = await this.getDefaultBranch();
    const { data: ref } = await this.octokit.rest.git.getRef({ ...this.repo, ref: `heads/${base}` });
    await this.octokit.rest.git.createRef({ ...this.repo, ref: `refs/heads/${file.branch}`, sha: ref.object.sha });

    let existingSha: string | undefined;
    try {
      const { data } = await this.octokit.rest.repos.getContent({ ...this.repo, path: file.path, ref: file.branch });
      if (!Array.isArray(data) && data.type === "file") existingSha = data.sha;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "status" in error && error.status === 404)) throw error;
    }
    await this.octokit.rest.repos.createOrUpdateFileContents({
      ...this.repo,
      path: file.path,
      branch: file.branch,
      message: file.title,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      ...(existingSha !== undefined && { sha: existingSha }),
    });
    const { data: pr } = await this.octokit.rest.pulls.create({
      ...this.repo,
      base,
      head: file.branch,
      title: file.title,
      body: file.body,
    });
    return pr.html_url;
  }
}
