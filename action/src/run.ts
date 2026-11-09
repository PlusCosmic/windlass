import { createHash } from "node:crypto";
import { decide, type DecisionRecord, type PolicyResult } from "../../src/index.js";
import { commentSha, renderComment, renderWaiting } from "./comment.js";
import type { GitHubPort } from "./port.js";

export const LABEL_PREFIX = "windlass/";

/** Labels per outcome. In shadow mode a merge is only labelled, never performed. */
export const OUTCOME_LABELS = {
  merge: `${LABEL_PREFIX}would-merge`,
  escalate: `${LABEL_PREFIX}escalate`,
  block: `${LABEL_PREFIX}block`,
} as const;

export interface RunConfig {
  /** Path of the policy file on the base branch. */
  policyPath: string;
}

export type PullRequestResult =
  | { status: "decided"; number: number; decision: DecisionRecord }
  | { status: "pending"; number: number; decision: DecisionRecord }
  | { status: "skipped"; number: number; reason: string };

/**
 * Evaluates one PR in shadow mode: decides, then reports the decision as a
 * comment and a label. Never merges.
 *
 * A pending decision (CI still running) posts nothing new, but clears labels and
 * marks any earlier comment as out of date so a stale verdict isn't left showing.
 */
export async function evaluatePullRequest(
  github: GitHubPort,
  number: number,
  config: RunConfig,
): Promise<PullRequestResult> {
  const pr = await github.getPullRequest(number);
  if (pr.state !== "open") return { status: "skipped", number, reason: "the pull request is closed" };
  if (pr.draft) return { status: "skipped", number, reason: "the pull request is a draft" };

  // Always the base branch: a PR must never be judged by a policy it can edit.
  const policySource = await github.getFile(config.policyPath, pr.baseRef);
  const [diff, checks] = await Promise.all([github.getDiff(number), github.getChecks(pr.headSha)]);

  // The diff is fetched for the PR, not a SHA; if the head moved meanwhile, a newer run will decide.
  const current = await github.getPullRequest(number);
  if (current.headSha !== pr.headSha) {
    return { status: "skipped", number, reason: `the head moved to ${current.headSha} during evaluation` };
  }

  const decision = await decide(
    { baseSha: pr.baseSha, headSha: pr.headSha, body: pr.body, diff, ci: { checks } },
    { policy: policySource ?? missingPolicy(config.policyPath, pr.baseRef) },
  );

  const existing = await github.findComment(number);
  if (decision.outcome === "pending") {
    await setOutcomeLabel(github, number, null);
    const previousSha = existing ? commentSha(existing.body) : null;
    if (existing && previousSha !== pr.headSha) {
      await github.updateComment(existing.id, renderWaiting(pr.headSha, previousSha));
    }
    return { status: "pending", number, decision };
  }

  const body = renderComment(decision);
  if (existing) await github.updateComment(existing.id, body);
  else await github.createComment(number, body);
  await setOutcomeLabel(github, number, OUTCOME_LABELS[decision.outcome]);
  return { status: "decided", number, decision };
}

/** Leaves exactly one Windlass outcome label on the PR (or none). */
async function setOutcomeLabel(github: GitHubPort, number: number, label: string | null): Promise<void> {
  const labels = await github.getLabels(number);
  for (const stale of labels.filter((l) => l.startsWith(LABEL_PREFIX) && l !== label)) {
    await github.removeLabel(number, stale);
  }
  if (label && !labels.includes(label)) await github.addLabels(number, [label]);
}

function missingPolicy(path: string, ref: string): PolicyResult {
  return {
    ok: false,
    hash: createHash("sha256").update("").digest("hex"),
    errors: [{ path: "", message: `no policy file at ${path} on ${ref}` }],
  };
}

/** The minimal parts of a webhook payload used to find which PRs to evaluate. */
export interface EventPayload {
  pull_request?: { number: number };
  workflow_run?: { head_sha: string; pull_requests?: { number: number }[] };
}

/**
 * Works out which PRs an event is about.
 *
 * - `pull_request`: that PR.
 * - `workflow_run` (CI finished): the run's PRs, or open PRs whose head is the run's commit.
 * - `workflow_dispatch`: the `pull-request` input.
 */
export async function resolvePullRequests(
  eventName: string,
  payload: EventPayload,
  github: GitHubPort,
  manual: number | null,
): Promise<number[]> {
  if (manual !== null) return [manual];
  switch (eventName) {
    case "pull_request":
      if (!payload.pull_request) throw new Error("pull_request event without a pull_request payload");
      return [payload.pull_request.number];
    case "workflow_run": {
      const run = payload.workflow_run;
      if (!run) throw new Error("workflow_run event without a workflow_run payload");
      const listed = (run.pull_requests ?? []).map((pr) => pr.number);
      return listed.length > 0 ? listed : github.findOpenPullRequests(run.head_sha);
    }
    case "workflow_dispatch":
      throw new Error("workflow_dispatch needs the `pull-request` input");
    default:
      return [];
  }
}
