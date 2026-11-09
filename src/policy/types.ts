/**
 * Normalized policy model. This is what the engine walks and what the future
 * flowchart editor will render; the YAML file is parsed into it by `parsePolicy`.
 */

/** Terminal outcomes a policy path can end in. */
export type Outcome = "merge" | "escalate" | "block";

/** What a failed gate contributes to the decision. */
export type FailOutcome = "escalate" | "block";

export interface GateNode {
  /** Stable node id used in decision records, e.g. `always[0]:ci_green`. */
  id: string;
  /** Registered gate name, e.g. `paths_only`. */
  gate: string;
  /** Gate arguments, already validated against the gate's argument schema. */
  args: unknown;
  /** Overrides the gate's default fail outcome. */
  onFail?: FailOutcome;
}

export interface EvaluatorNode {
  /** Stable node id, e.g. `flagged_feature.eval[0]:fully_flag_gated`. */
  id: string;
  /** Evaluator name, e.g. `fully_flag_gated`. */
  evaluator: string;
  /** Verdicts below this confidence escalate. */
  minConfidence: number;
  /** Model to run the evaluator on; the runner picks a default when absent. */
  model?: string;
}

export interface Category {
  name: string;
  gates: GateNode[];
  evaluators: EvaluatorNode[];
  /** Outcome when every gate passes and every evaluator is satisfied. */
  outcome: Outcome;
}

export interface Policy {
  version: "v1";
  defaults: {
    /** Gates run on every path, whatever the declared category. */
    always: GateNode[];
    onEvaluatorError: "escalate";
  };
  /** Keyed by category name, in file order. */
  categories: Record<string, Category>;
  /** Outcome for a declared category the policy doesn't define. */
  fallback: FailOutcome;
}
