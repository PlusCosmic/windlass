import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { renderComment } from "./comment.js";
import { OctokitPort } from "./octokit.js";
import { evaluatePullRequest, resolvePullRequests, type EventPayload, type PullRequestResult } from "./run.js";

async function main(): Promise<void> {
  const mode = core.getInput("mode") || "shadow";
  if (mode !== "shadow") throw new Error(`mode \`${mode}\` is not supported; only \`shadow\` is available in v1`);

  const manualInput = core.getInput("pull-request");
  const manual = manualInput ? Number(manualInput) : null;
  if (manual !== null && !(Number.isInteger(manual) && manual > 0)) {
    throw new Error(`\`pull-request\` must be a PR number, got ${JSON.stringify(manualInput)}`);
  }

  const { context } = github;
  const port = new OctokitPort(github.getOctokit(core.getInput("github-token", { required: true })), {
    ...context.repo,
    runId: context.runId,
    // Windlass's own job shows up as a check named after the job; it must never wait on itself.
    ignoreChecks: [context.job, ...core.getMultilineInput("ignore-checks")],
    commentAuthor: core.getInput("comment-author") || "github-actions[bot]",
  });

  const numbers = await resolvePullRequests(context.eventName, context.payload as EventPayload, port, manual);
  if (numbers.length === 0) {
    core.info(`Nothing to evaluate for a ${context.eventName} event.`);
    return;
  }

  const outDir = join(process.env.RUNNER_TEMP ?? ".", "windlass");
  await mkdir(outDir, { recursive: true });
  const results: PullRequestResult[] = [];
  let failures = 0;

  for (const number of numbers) {
    try {
      const result = await evaluatePullRequest(port, number, {
        policyPath: core.getInput("policy-path") || ".windlass/policy.yaml",
      });
      results.push(result);
      if (result.status === "skipped") {
        core.info(`#${number}: skipped, ${result.reason}`);
        continue;
      }
      const { decision } = result;
      core.info(`#${number}: ${decision.outcome}${decision.reasons.length ? ` (${decision.reasons.join("; ")})` : ""}`);
      await writeFile(join(outDir, `decision-${number}.json`), `${JSON.stringify(decision, null, 2)}\n`);
      if (result.status === "decided") {
        core.summary.addRaw(renderComment(decision), true);
      } else {
        core.summary.addRaw(`#${number}: ⏳ waiting on CI for \`${decision.headSha.slice(0, 7)}\``, true);
      }
    } catch (error) {
      failures++;
      core.error(`#${number}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }

  await core.summary.write();
  const decided = results.filter((r) => r.status !== "skipped");
  core.setOutput("decision-dir", outDir);
  core.setOutput("decisions", JSON.stringify(decided.map((r) => r.decision)));
  if (decided.length === 1) core.setOutput("outcome", decided[0]!.decision.outcome);

  if (failures > 0) core.setFailed(`${failures} pull request(s) could not be evaluated`);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
