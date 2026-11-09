import type { z } from "zod";
import type { Facts } from "../facts/types.js";
import type { Intent } from "../intent.js";
import type { FailOutcome } from "../policy/types.js";

/** A file reference supporting a gate or evaluator result. */
export interface Evidence {
  file: string;
  line?: number;
  detail: string;
}

/**
 * - `pass` / `fail`: the check ran and has an answer.
 * - `error`: the check couldn't run (missing data, bad input); the engine escalates.
 * - `pending`: the answer isn't known yet (e.g. CI still running); the decision is deferred.
 */
export type GateStatus = "pass" | "fail" | "error" | "pending";

export interface GateResult {
  status: GateStatus;
  reason: string;
  evidence?: Evidence[];
}

export interface GateContext<A> {
  facts: Facts;
  /** Null when the PR declared no valid intent; always-gates still run then. */
  intent: Intent | null;
  args: A;
}

/** A deterministic pass/fail check. Gates are authoritative: nothing overrides a failed gate. */
export interface GateDefinition<A = unknown> {
  name: string;
  description: string;
  /** What a failure contributes unless the policy sets `on_fail`. */
  defaultOnFail: FailOutcome;
  /** Validates the gate's arguments when the policy is parsed. */
  args: z.ZodType<A>;
  run(ctx: GateContext<A>): GateResult | Promise<GateResult>;
}

/** Helper that keeps a gate's argument type tied to its schema. */
export function defineGate<A>(gate: GateDefinition<A>): GateDefinition<A> {
  return gate;
}
