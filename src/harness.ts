import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { DecisionOutcome, DecisionRecord } from "./decision.js";
import { decide, type DecideOptions } from "./engine.js";
import type { PullRequestInput } from "./facts/types.js";

/**
 * Fixture-based harness: runs a policy against a sample PR without GitHub.
 *
 * A fixture is a directory containing:
 *   - case.yaml   the PR body, CI checks and expected decision (see `CaseSchema`)
 *   - diff.patch  the PR's unified diff
 *   - policy.yaml optional; otherwise `policy:` in case.yaml, or the parent dir's policy.yaml
 */

const CaseSchema = z.strictObject({
  description: z.string().optional(),
  policy: z.string().optional(),
  base_sha: z.string().default("0000000000000000000000000000000000000000"),
  head_sha: z.string().default("1111111111111111111111111111111111111111"),
  body: z.string().default(""),
  /** Omit to model "CI status not collected". */
  ci: z
    .array(
      z.strictObject({
        name: z.string(),
        status: z.enum(["queued", "in_progress", "completed"]).default("completed"),
        conclusion: z
          .enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"])
          .nullable()
          .optional(),
      }),
    )
    .optional(),
  expect: z.strictObject({
    outcome: z.enum(["merge", "escalate", "block", "pending"]),
    category: z.string().nullable().optional(),
    /** Each entry must appear as a substring of some reason. */
    reasons: z.array(z.string()).optional(),
    /** Expected status per gate node id, e.g. `always[1]:no_new_skips: fail`. */
    gates: z.record(z.string(), z.enum(["pass", "fail", "error", "pending"])).optional(),
  }),
});

export type FixtureExpectation = z.infer<typeof CaseSchema>["expect"];

export interface Fixture {
  name: string;
  dir: string;
  description?: string;
  policyPath: string;
  policySource: string;
  input: PullRequestInput;
  expect: FixtureExpectation;
}

export interface FixtureRun {
  fixture: Fixture;
  decision: DecisionRecord;
  /** Empty when the decision matches every expectation. */
  mismatches: string[];
}

export function loadFixture(dir: string): Fixture {
  const casePath = join(dir, "case.yaml");
  const raw = CaseSchema.parse(parseYaml(readFileSync(casePath, "utf8")));
  const policyPath = resolvePolicyPath(dir, raw.policy);
  const diffPath = join(dir, "diff.patch");

  const input: PullRequestInput = {
    baseSha: raw.base_sha,
    headSha: raw.head_sha,
    body: raw.body,
    diff: existsSync(diffPath) ? readFileSync(diffPath, "utf8") : "",
  };
  if (raw.ci) input.ci = { checks: raw.ci };

  const fixture: Fixture = {
    name: dir.split(/[\\/]/).at(-1)!,
    dir,
    policyPath,
    policySource: readFileSync(policyPath, "utf8"),
    input,
    expect: raw.expect,
  };
  if (raw.description !== undefined) fixture.description = raw.description;
  return fixture;
}

/** Fixture directories (those with a case.yaml) directly under `root`, sorted by name. */
export function listFixtures(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "case.yaml")))
    .map((entry) => join(root, entry.name))
    .sort();
}

export async function runFixture(dir: string, options: Omit<DecideOptions, "policy"> = {}): Promise<FixtureRun> {
  const fixture = loadFixture(dir);
  const decision = await decide(fixture.input, {
    now: () => new Date(0),
    ...options,
    policy: fixture.policySource,
  });
  return { fixture, decision, mismatches: checkExpectation(decision, fixture.expect) };
}

export function checkExpectation(decision: DecisionRecord, expect: FixtureExpectation): string[] {
  const mismatches: string[] = [];
  const expectOutcome: DecisionOutcome = expect.outcome;
  if (decision.outcome !== expectOutcome) {
    mismatches.push(
      `outcome: expected ${expectOutcome}, got ${decision.outcome} (${decision.reasons.join("; ") || "no reasons"})`,
    );
  }
  if (expect.category !== undefined && decision.category !== expect.category) {
    mismatches.push(`category: expected ${expect.category}, got ${decision.category}`);
  }
  for (const fragment of expect.reasons ?? []) {
    if (!decision.reasons.some((reason) => reason.includes(fragment))) {
      mismatches.push(`reasons: none contain ${JSON.stringify(fragment)} (got ${JSON.stringify(decision.reasons)})`);
    }
  }
  for (const [node, status] of Object.entries(expect.gates ?? {})) {
    const gate = decision.gates.find((g) => g.node === node);
    if (!gate)
      mismatches.push(`gates: node ${node} did not run (ran: ${decision.gates.map((g) => g.node).join(", ")})`);
    else if (gate.status !== status)
      mismatches.push(`gates: ${node} expected ${status}, got ${gate.status} (${gate.reason})`);
  }
  return mismatches;
}

function resolvePolicyPath(dir: string, declared: string | undefined): string {
  if (declared !== undefined) return resolve(dir, declared);
  for (const candidate of [join(dir, "policy.yaml"), join(dirname(dir), "policy.yaml")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`fixture ${dir}: no policy.yaml found and none declared in case.yaml`);
}
