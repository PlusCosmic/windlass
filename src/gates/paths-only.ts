import { z } from "zod";
import { globMatcher, touchedPaths } from "./paths.js";
import { defineGate } from "./types.js";

/** Passes when every changed path (including the old side of renames) matches one of the globs. */
export const pathsOnly = defineGate({
  name: "paths_only",
  description: "Every changed file matches one of the given globs",
  defaultOnFail: "escalate",
  args: z.array(z.string().min(1)).min(1),
  run({ facts, args }) {
    if (facts.files.length === 0) return { status: "error", reason: "the diff changes no files" };

    const matches = globMatcher(args);
    const outside = facts.files.flatMap((file) => touchedPaths(file).filter((path) => !matches(path)));
    if (outside.length === 0) {
      return { status: "pass", reason: `all ${facts.files.length} changed file(s) match ${args.join(", ")}` };
    }
    return {
      status: "fail",
      reason: `${outside.length} changed path(s) fall outside ${args.join(", ")}`,
      evidence: outside.map((file) => ({ file, detail: "outside the allowed paths" })),
    };
  },
});
