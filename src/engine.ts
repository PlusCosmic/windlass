import { collectFacts } from "./facts/collect.js";
import type { Facts, PullRequestInput } from "./facts/types.js";
import {
  mostSevere,
  type BuiltinRecord,
  type DecisionOutcome,
  type DecisionRecord,
  type EvaluatorRecord,
  type GateRecord,
} from "./decision.js";
import { resolveQuestion } from "./evaluators/question.js";
import {
  EvaluatorNotRun,
  MAX_EVIDENCE,
  MAX_EVIDENCE_DETAIL,
  VerdictSchema,
  type EvaluatorRunner,
} from "./evaluators/types.js";
import { globMatcher, touchedPaths } from "./gates/paths.js";
import { defaultGateRegistry, type GateRegistry } from "./gates/registry.js";
import type { GateResult } from "./gates/types.js";
import { parseIntent, type Intent } from "./intent.js";
import { parsePolicy, type PolicyResult } from "./policy/parse.js";
import type { EvaluatorNode, GateNode } from "./policy/types.js";
import { ENGINE_VERSION } from "./version.js";

/** Changes to these paths always escalate, so a PR can't loosen the policy that judges it. */
export const PROTECTED_PATHS = [".windlass/**"];

export interface DecideOptions {
  /** Policy source (YAML, loaded from the base branch) or an already parsed policy. */
  policy: string | PolicyResult;
  /** Gates available to the policy; defaults to the built-in gates. */
  gates?: GateRegistry;
  /** Runs evaluator nodes. Without one, any evaluator node errors and escalates. */
  evaluators?: EvaluatorRunner;
  evaluatorTimeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_EVALUATOR_TIMEOUT_MS = 120_000;

/**
 * Walks a pull request through the policy and returns the decision record.
 *
 * Order: protected paths, declared intent, always-gates, then the declared
 * category's gates, then its evaluators. Every gate runs so the record is
 * complete; evaluators only run when nothing has already pushed the PR off the
 * merge path, since they can't change the outcome then. Contributions combine
 * by severity (see `mostSevere`), so a failed gate can never be overridden.
 *
 * Never throws for bad input: anything unexpected becomes an escalation.
 */
export async function decide(input: PullRequestInput, options: DecideOptions): Promise<DecisionRecord> {
  const registry = options.gates ?? defaultGateRegistry();
  const loaded = typeof options.policy === "string" ? parsePolicy(options.policy, registry) : options.policy;

  const contributions: DecisionOutcome[] = [];
  const reasons: string[] = [];
  const contribute = (outcome: DecisionOutcome, reason: string) => {
    contributions.push(outcome);
    if (outcome !== "merge") reasons.push(reason);
  };

  // Read before anything can return early, so every record says what the PR declared.
  const parsedIntent = parseIntent(input.body);
  const intent: Intent | null = parsedIntent.ok ? parsedIntent.intent : null;

  const record: DecisionRecord = {
    schema: "windlass.decision/v1",
    outcome: "escalate",
    reasons,
    path: ["policy"],
    category: null,
    intent,
    builtins: [],
    gates: [],
    evaluators: [],
    changes: null,
    policy: {
      version: loaded.ok ? loaded.policy.version : null,
      hash: loaded.hash,
      errors: loaded.ok ? [] : loaded.errors,
    },
    baseSha: input.baseSha,
    headSha: input.headSha,
    engineVersion: ENGINE_VERSION,
    decidedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const finish = () => {
    record.outcome = contributions.length === 0 ? "escalate" : mostSevere(contributions);
    return record;
  };

  const builtin = (node: BuiltinRecord["node"], failure: string | null) => {
    record.builtins.push({ node, status: failure === null ? "pass" : "fail", reason: failure ?? "" });
    contribute(failure === null ? "merge" : "escalate", failure ?? "");
  };

  if (!loaded.ok) {
    builtin("policy", `policy is invalid (${loaded.errors.length} error(s))`);
    return finish();
  }
  builtin("policy", null);
  const { policy } = loaded;

  let facts: Facts;
  try {
    facts = collectFacts(input);
  } catch (error) {
    contribute("escalate", `could not read the diff: ${message(error)}`);
    return finish();
  }
  record.changes = {
    files: facts.files.map((file) => file.path),
    additions: facts.stats.additions,
    deletions: facts.stats.deletions,
  };

  record.path.push("protected_paths");
  const isProtected = globMatcher(PROTECTED_PATHS);
  const protectedTouched = facts.files.flatMap(touchedPaths).filter(isProtected);
  builtin(
    "protected_paths",
    protectedTouched.length > 0 ? `changes Windlass policy files: ${protectedTouched.join(", ")}` : null,
  );

  record.path.push("intent");
  builtin("intent", parsedIntent.ok ? null : `intent: ${parsedIntent.reason}`);

  for (const node of policy.defaults.always) {
    record.path.push(node.id);
    const gate = await runGate(node, "always", facts, intent, registry);
    record.gates.push(gate);
    contribute(gateContribution(gate), `${node.id}: ${gate.reason}`);
  }

  if (!intent) return finish();

  // hasOwn first: a declared category like `constructor` must not resolve via the prototype.
  const category = Object.hasOwn(policy.categories, intent.category) ? policy.categories[intent.category] : undefined;
  if (!category) {
    record.path.push("fallback");
    contribute(policy.fallback, `category \`${intent.category}\` is not defined in the policy`);
    return finish();
  }
  record.category = category.name;
  record.path.push(`category:${category.name}`);

  for (const node of category.gates) {
    record.path.push(node.id);
    const gate = await runGate(node, "category", facts, intent, registry);
    record.gates.push(gate);
    contribute(gateContribution(gate), `${node.id}: ${gate.reason}`);
  }

  for (const node of category.evaluators) {
    if (mostSevere(contributions) !== "merge") {
      record.evaluators.push(skippedEvaluator(node));
      continue;
    }
    record.path.push(node.id);
    const evaluation = await runEvaluator(node, facts, intent, options);
    record.evaluators.push(evaluation);
    contribute(
      evaluation.status === "pass" ? "merge" : policy.defaults.onEvaluatorError,
      `${node.id}: ${evaluation.reason}`,
    );
  }

  record.path.push(`outcome:${category.outcome}`);
  contribute(category.outcome, `category \`${category.name}\` routes to ${category.outcome}`);
  return finish();
}

async function runGate(
  node: GateNode,
  scope: GateRecord["scope"],
  facts: Facts,
  intent: Intent | null,
  registry: GateRegistry,
): Promise<GateRecord> {
  const gate = registry.get(node.gate);
  const onFail = node.onFail ?? gate?.defaultOnFail ?? "escalate";
  let result: GateResult;
  if (!gate) {
    result = { status: "error", reason: `gate \`${node.gate}\` is not registered` };
  } else {
    try {
      result = await gate.run({ facts, intent, args: node.args });
    } catch (error) {
      result = { status: "error", reason: `gate threw: ${message(error)}` };
    }
  }
  return {
    node: node.id,
    gate: node.gate,
    scope,
    status: result.status,
    onFail,
    reason: result.reason,
    evidence: result.evidence ?? [],
  };
}

function gateContribution(gate: GateRecord): DecisionOutcome {
  switch (gate.status) {
    case "pass":
      return "merge";
    case "fail":
      return gate.onFail;
    case "pending":
      return "pending";
    case "error":
      return "escalate";
  }
}

async function runEvaluator(
  node: EvaluatorNode,
  facts: Facts,
  intent: Intent,
  options: DecideOptions,
): Promise<EvaluatorRecord> {
  const base: EvaluatorRecord = {
    node: node.id,
    evaluator: node.evaluator,
    status: "error",
    model: node.model ?? null,
    minConfidence: node.minConfidence,
    verdict: null,
    confidence: null,
    reason: "",
    evidence: [],
  };
  if (!options.evaluators) return { ...base, reason: "no evaluator runner is configured" };

  const question = resolveQuestion(node.question, intent);
  if (!question.ok) {
    const names = question.missing.map((name) => `\`${name}\``).join(", ");
    return { ...base, reason: `the question needs ${names}, which the PR did not declare` };
  }

  const request = {
    evaluator: node.evaluator,
    question: question.question,
    ...(node.model !== undefined && { model: node.model }),
    headSha: facts.headSha,
    diff: facts.diff,
    intent,
    facts: {
      files: facts.files.map(({ path, previousPath, status, additions, deletions }) => ({
        path,
        ...(previousPath !== undefined && { previousPath }),
        status,
        additions,
        deletions,
      })),
      stats: facts.stats,
    },
  };

  const timeoutMs = options.evaluatorTimeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let response;
  try {
    response = await Promise.race([
      options.evaluators.run(request, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof EvaluatorNotRun) return { ...base, status: "not_run", reason: error.message };
    return { ...base, reason: `evaluator failed: ${message(error)}` };
  } finally {
    clearTimeout(timer);
  }

  const parsed = VerdictSchema.safeParse(response?.output);
  const model = typeof response?.model === "string" ? response.model : base.model;
  if (!parsed.success) return { ...base, model, reason: "evaluator returned malformed output" };

  const { verdict, confidence } = parsed.data;
  const evidence = parsed.data.evidence
    .slice(0, MAX_EVIDENCE)
    .map((item) => ({ ...item, detail: item.detail.slice(0, MAX_EVIDENCE_DETAIL) }));

  // Evidence has to point at the change itself. A verdict that cites files the diff
  // doesn't touch was not reached by reading the diff, so it isn't one to act on.
  const changed = new Set(facts.files.flatMap(touchedPaths));
  const stray = evidence.find((item) => !changed.has(item.file));
  if (stray) return { ...base, model, reason: "evaluator cited a file the diff does not change" };
  if (verdict === "fail" && evidence.length === 0) {
    return { ...base, model, reason: "evaluator failed the PR without evidence" };
  }

  const result = { ...base, model, verdict, confidence, evidence };
  if (confidence < node.minConfidence) {
    return {
      ...result,
      status: "low_confidence",
      reason: `confidence ${confidence} is below ${node.minConfidence}`,
    };
  }
  if (verdict === "fail") return { ...result, status: "fail", reason: "evaluator verdict: fail" };
  return { ...result, status: "pass", reason: `evaluator verdict: pass (confidence ${confidence})` };
}

function skippedEvaluator(node: EvaluatorNode): EvaluatorRecord {
  return {
    node: node.id,
    evaluator: node.evaluator,
    status: "skipped",
    model: node.model ?? null,
    minConfidence: node.minConfidence,
    verdict: null,
    confidence: null,
    reason: "not run: the PR is already off the merge path",
    evidence: [],
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
