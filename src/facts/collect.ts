import { diffStats, parseDiff } from "./diff.js";
import type { Facts, PullRequestInput } from "./types.js";

/** Computes the facts gates and evaluators work from. Throws if the diff can't be parsed. */
export function collectFacts(input: PullRequestInput): Facts {
  const files = parseDiff(input.diff);
  return {
    baseSha: input.baseSha,
    headSha: input.headSha,
    diff: input.diff,
    files,
    stats: diffStats(files),
    ci: input.ci ?? null,
  };
}
