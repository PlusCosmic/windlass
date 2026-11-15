import { z } from "zod";
import { globMatcher, touchedPaths } from "./paths.js";
import { defineGate } from "./types.js";

/** Passes when no changed path (including the old side of renames) matches any of the globs. */
export const pathsNone = defineGate({
  name: "paths_none",
  description: "No changed file matches any of the given globs",
  defaultOnFail: "escalate",
  args: z.array(z.string().min(1)).min(1),
  run({ facts, args }) {
    const matches = globMatcher(args);
    const inside = [...new Set(facts.files.flatMap((file) => touchedPaths(file).filter(matches)))];
    if (inside.length === 0) return { status: "pass", reason: `no changed file matches ${args.join(", ")}` };
    return {
      status: "fail",
      reason: `${inside.length} changed path(s) match ${args.join(", ")}`,
      evidence: inside.map((file) => ({ file, detail: "matches a path this category must not change" })),
    };
  },
});
