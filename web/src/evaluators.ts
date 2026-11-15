import { isMap, parseDocument } from "yaml";
import type { EvaluatorRecord, EvaluatorStatus } from "../../src/decision";
import { NOT_RUN_WAITING } from "../../src/evaluators/reasons";
import type { EvaluatorRef } from "../../src/graph";
import type { SimulatedPull } from "./api";

/** What a new evaluator asks for until someone changes it. */
export const DEFAULT_MIN_CONFIDENCE = 0.85;

export const EVALUATOR_NAME = /^[a-z][a-z0-9_]*$/;

/** The id the parser will give an evaluator at this place in the policy. */
export function evaluatorId(category: string, index: number, name: string): string {
  return `${category}.eval[${index}]:${name}`;
}

/** A confidence to two places, without trailing zeros: 0.85, 0.9, 1. */
export function formatConfidence(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * An evaluator as the file has it, before validation. Null fields are ones the
 * policy leaves out: the built-in question, the runner's default model. Read
 * from the draft itself, so a form shows what was typed without waiting for a replay.
 */
export function readEvaluator(
  source: string,
  ref: EvaluatorRef,
): { question: string | null; minConfidence: number | null; model: string | null } | null {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return null;
  const entry = doc.getIn(["categories", ref.category, "evaluators", ref.index]);
  if (!isMap(entry)) return null;
  const question: unknown = entry.get("question");
  const minConfidence: unknown = entry.get("min_confidence");
  const model: unknown = entry.get("model");
  return {
    question: typeof question === "string" ? question : null,
    minConfidence: typeof minConfidence === "number" ? minConfidence : null,
    model: typeof model === "string" ? model : null,
  };
}

/** How an evaluator can come out for a pull request that reached it. */
export type RunStatus = Exclude<EvaluatorStatus, "skipped">;

export const RUN_STATUSES = ["pass", "fail", "low_confidence", "not_run", "error"] as const satisfies RunStatus[];

export interface EvaluatorRun {
  pull: SimulatedPull;
  record: EvaluatorRecord;
  status: RunStatus;
  /** Its question is with a runner, and the answer hasn't come back. */
  waiting: boolean;
}

export interface EvaluatorRuns {
  runs: EvaluatorRun[];
  counts: Record<RunStatus, number>;
  /** Pull requests with no answer that nobody has asked for yet. */
  runnable: number;
}

/**
 * What one evaluator made of the replayed pull requests, under the draft. Only
 * the ones that reached it count: a pull request already off the merge path is never asked about.
 */
export function evaluatorRuns(node: string, pulls: readonly SimulatedPull[]): EvaluatorRuns {
  const runs: EvaluatorRun[] = [];
  const counts: Record<RunStatus, number> = { pass: 0, fail: 0, low_confidence: 0, not_run: 0, error: 0 };
  let runnable = 0;

  for (const pull of pulls) {
    const record = pull.draft.evaluators.find((candidate) => candidate.node === node);
    if (!record || record.status === "skipped") continue;
    const { status } = record;
    const waiting = status === "not_run" && record.reason === NOT_RUN_WAITING;
    if (status === "not_run" && !waiting) runnable++;
    counts[status]++;
    runs.push({ pull, record, status, waiting });
  }
  return { runs, counts, runnable };
}
