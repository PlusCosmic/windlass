import { z } from "zod";
import { defineGate } from "./types.js";

/**
 * Passes when the feature flag the PR declares appears in a line the diff adds.
 * It doesn't show the change is behind the flag (that is a question for an
 * evaluator), only that the declared flag is one the change actually uses.
 */
export const flagReferenced = defineGate({
  name: "flag_referenced",
  description: "The feature flag the PR declares appears in a line it adds",
  defaultOnFail: "escalate",
  args: z.strictObject({}).optional(),
  run({ facts, intent }) {
    if (!intent) return { status: "error", reason: "the PR declared no intent" };
    const flag = intent.flag;
    if (flag === undefined) return { status: "fail", reason: "the PR declares no `flag`" };

    for (const file of facts.files) {
      const hit = file.addedLines.find((line) => line.text.includes(flag));
      if (hit) {
        return {
          status: "pass",
          reason: `flag \`${flag}\` is referenced in ${file.path}`,
          evidence: [{ file: file.path, line: hit.line, detail: "references the declared flag" }],
        };
      }
    }
    return { status: "fail", reason: `no added line references the flag \`${flag}\`` };
  },
});
