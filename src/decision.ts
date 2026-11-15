import type { Evidence, GateStatus } from "./gates/types.js";
import type { Intent } from "./intent.js";
import type { PolicyError } from "./policy/parse.js";
import type { FailOutcome, Outcome } from "./policy/types.js";

/**
 * `pending` is not a terminal outcome: the decision is deferred until missing
 * facts (e.g. CI) arrive, and the adapter should neither merge nor comment.
 */
export type DecisionOutcome = Outcome | "pending";

export interface GateRecord {
  node: string;
  gate: string;
  scope: "always" | "category";
  status: GateStatus;
  /** What a failure of this gate contributes. */
  onFail: FailOutcome;
  reason: string;
  evidence: Evidence[];
}

/** The checks the engine runs on every PR before the policy's own nodes. */
export type BuiltinNode = "policy" | "protected_paths" | "intent";

export interface BuiltinRecord {
  node: BuiltinNode;
  status: "pass" | "fail";
  /** Why it failed; empty on pass. */
  reason: string;
}

/**
 * `not_run` is an evaluator nobody has asked yet (a replay that only reads stored
 * verdicts, or no runner connected). Like `error`, it escalates.
 */
export type EvaluatorStatus = "pass" | "fail" | "low_confidence" | "error" | "not_run" | "skipped";

export interface EvaluatorRecord {
  node: string;
  evaluator: string;
  status: EvaluatorStatus;
  /** Model ID that produced the verdict; the requested model when it never ran. */
  model: string | null;
  minConfidence: number;
  verdict: "pass" | "fail" | null;
  confidence: number | null;
  reason: string;
  evidence: Evidence[];
}

export interface DecisionRecord {
  schema: "windlass.decision/v1";
  outcome: DecisionOutcome;
  /** Why the outcome isn't `merge`, one entry per contributing node. Empty on merge. */
  reasons: string[];
  /** Node ids visited, in order. */
  path: string[];
  category: string | null;
  intent: Intent | null;
  /** One entry per built-in check that ran, in order. A failed one escalates. */
  builtins: BuiltinRecord[];
  gates: GateRecord[];
  evaluators: EvaluatorRecord[];
  changes: { files: string[]; additions: number; deletions: number } | null;
  policy: { version: string | null; hash: string; errors: PolicyError[] };
  baseSha: string;
  headSha: string;
  engineVersion: string;
  decidedAt: string;
}

/** Precedence when combining contributions: the most severe wins. */
const SEVERITY: Record<DecisionOutcome, number> = { merge: 0, escalate: 1, pending: 2, block: 3 };

/**
 * Combines node contributions into one outcome. `block` beats everything;
 * `pending` beats `escalate` because a deferred gate could still turn into a block.
 */
export function mostSevere(outcomes: readonly DecisionOutcome[]): DecisionOutcome {
  return outcomes.reduce<DecisionOutcome>((worst, o) => (SEVERITY[o] > SEVERITY[worst] ? o : worst), "merge");
}
