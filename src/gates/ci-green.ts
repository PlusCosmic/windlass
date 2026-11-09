import { z } from "zod";
import type { CheckConclusion, CheckRun } from "../facts/types.js";
import { defineGate } from "./types.js";

const PASSING: ReadonlySet<CheckConclusion> = new Set(["success", "neutral", "skipped"]);

/**
 * Passes when CI on the head commit is green.
 *
 * - `required`: checks that must be present and passing. Until they all report,
 *   the gate is pending. Without it, every reported check must pass.
 * - `ignore`: check names to disregard, such as Windlass's own check.
 *
 * Any failed check fails the gate, even while others are still running.
 */
export const ciGreen = defineGate({
  name: "ci_green",
  description: "CI checks on the head commit passed",
  defaultOnFail: "escalate",
  args: z
    .strictObject({
      required: z.array(z.string().min(1)).min(1).optional(),
      ignore: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  run({ facts, args }) {
    if (!facts.ci) return { status: "error", reason: "CI status was not collected" };

    const ignored = new Set(args?.ignore ?? []);
    const checks = facts.ci.checks.filter((check) => !ignored.has(check.name));
    const required = args?.required ?? [];

    const failed = checks.filter((check) => check.status === "completed" && !passed(check));
    if (failed.length > 0) {
      return {
        status: "fail",
        reason: `${failed.length} CI check(s) did not pass: ${failed.map(describe).join(", ")}`,
      };
    }

    const missing = required.filter((name) => !checks.some((check) => check.name === name));
    const running = checks.filter((check) => check.status !== "completed");
    if (missing.length > 0 || running.length > 0) {
      const waiting = [...missing, ...running.map((check) => check.name)];
      return { status: "pending", reason: `waiting on CI: ${waiting.join(", ")}` };
    }

    if (checks.length === 0) return { status: "error", reason: "no CI checks reported for the head commit" };
    return { status: "pass", reason: `${checks.length} CI check(s) passed` };
  },
});

function passed(check: CheckRun): boolean {
  return check.conclusion != null && PASSING.has(check.conclusion);
}

function describe(check: CheckRun): string {
  return `${check.name} (${check.conclusion ?? "no conclusion"})`;
}
