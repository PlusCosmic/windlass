import { z } from "zod";
import type { ChangedFile, DiffStats } from "../facts/types.js";
import type { Intent } from "../intent.js";

/**
 * What an evaluator gets: the diff and gate-computed facts. The PR description,
 * commit messages and the authoring agent's reasoning are deliberately absent.
 */
export interface EvaluatorRequest {
  evaluator: string;
  model?: string;
  headSha: string;
  diff: string;
  /** Category and its references (`issue`, `flag`); structured, never free text. */
  intent: Intent;
  facts: {
    files: Pick<ChangedFile, "path" | "previousPath" | "status" | "additions" | "deletions">[];
    stats: DiffStats;
  };
}

export interface EvaluatorResponse {
  /** The exact model ID that produced the output, recorded in the decision. */
  model: string;
  /** Raw structured output; the engine validates it against `VerdictSchema`. */
  output: unknown;
}

/**
 * Runs evaluators, typically by calling an LLM in a fresh context. The engine
 * treats a thrown error, a timeout or output that fails validation as an
 * evaluator error, which escalates.
 */
export interface EvaluatorRunner {
  run(request: EvaluatorRequest, signal: AbortSignal): Promise<EvaluatorResponse>;
}

export const VerdictSchema = z.strictObject({
  verdict: z.enum(["pass", "fail"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(
    z.strictObject({
      file: z.string().min(1),
      line: z.number().int().positive().optional(),
      detail: z.string().min(1),
    }),
  ),
});

export type Verdict = z.infer<typeof VerdictSchema>;
