import { createHash } from "node:crypto";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import type { GateRegistry } from "../gates/registry.js";
import type { Category, EvaluatorNode, FailOutcome, GateNode, Policy } from "./types.js";

export interface PolicyError {
  /** Where in the file the problem is, e.g. `categories.test_only.gates[0]`. */
  path: string;
  message: string;
}

export interface LoadedPolicy {
  policy: Policy;
  /** sha256 of the policy source, recorded in every decision. */
  hash: string;
}

export type PolicyResult = ({ ok: true } & LoadedPolicy) | { ok: false; errors: PolicyError[]; hash: string };

const NAME = /^[a-z][a-z0-9_]*$/;
const FailOutcomeSchema = z.enum(["escalate", "block"]);

const RawGate = z.union([z.string(), z.record(z.string(), z.unknown())]);

const RawEvaluator = z.strictObject({
  id: z.string().regex(NAME, "must be a snake_case evaluator name"),
  min_confidence: z.number().min(0).max(1),
  model: z.string().min(1).optional(),
});

const RawCategory = z.strictObject({
  gates: z.array(RawGate).default([]),
  evaluators: z.array(RawEvaluator).default([]),
  outcome: z.enum(["merge", "escalate", "block"]),
});

const RawPolicy = z.strictObject({
  policy: z.literal("v1", { error: "must be `v1`" }),
  defaults: z
    .strictObject({
      always: z.array(RawGate).default([]),
      on_evaluator_error: z.literal("escalate", { error: "must be `escalate`" }).default("escalate"),
    })
    .default({ always: [], on_evaluator_error: "escalate" }),
  categories: z.record(z.string().regex(NAME, "must be a snake_case category name"), RawCategory),
  fallback: FailOutcomeSchema.default("escalate"),
});

/**
 * Parses and validates a policy file. Gate names and arguments are checked
 * against the registry, so a policy that references a gate the engine doesn't
 * have is invalid rather than silently skipped.
 */
export function parsePolicy(source: string, registry: GateRegistry): PolicyResult {
  const hash = createHash("sha256").update(source).digest("hex");

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    const message = error instanceof YAMLParseError ? error.message : String(error);
    return { ok: false, hash, errors: [{ path: "", message: `invalid YAML: ${message}` }] };
  }

  const structural = RawPolicy.safeParse(raw);
  if (!structural.success) {
    return {
      ok: false,
      hash,
      errors: structural.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
    };
  }

  const errors: PolicyError[] = [];
  const data = structural.data;
  const always = data.defaults.always.map((entry, i) =>
    normalizeGate(entry, `defaults.always[${i}]`, `always[${i}]`, registry, errors),
  );

  const categories: Record<string, Category> = {};
  for (const [name, category] of Object.entries(data.categories)) {
    categories[name] = {
      name,
      gates: category.gates.map((entry, i) =>
        normalizeGate(entry, `categories.${name}.gates[${i}]`, `${name}[${i}]`, registry, errors),
      ),
      evaluators: category.evaluators.map((entry, i): EvaluatorNode => {
        const node: EvaluatorNode = {
          id: `${name}.eval[${i}]:${entry.id}`,
          evaluator: entry.id,
          minConfidence: entry.min_confidence,
        };
        if (entry.model !== undefined) node.model = entry.model;
        return node;
      }),
      outcome: category.outcome,
    };
  }

  if (errors.length > 0) return { ok: false, hash, errors };
  return {
    ok: true,
    hash,
    policy: {
      version: data.policy,
      defaults: { always, onEvaluatorError: data.defaults.on_evaluator_error },
      categories,
      fallback: data.fallback,
    },
  };
}

/**
 * Accepts the three ways a gate can be written:
 *
 *   - no_migrations                       # bare name
 *   - paths_only: ["docs/**"]             # name: args
 *   - gate: ci_green                      # explicit form
 *     with: { required: [build] }
 *
 * Any form can also carry `on_fail: escalate | block`.
 */
function normalizeGate(
  entry: z.infer<typeof RawGate>,
  path: string,
  id: string,
  registry: GateRegistry,
  errors: PolicyError[],
): GateNode {
  let name: string;
  let args: unknown;
  let onFail: unknown;

  if (typeof entry === "string") {
    name = entry;
  } else if ("gate" in entry) {
    const { gate, with: withArgs, on_fail, ...rest } = entry;
    for (const key of Object.keys(rest)) errors.push({ path: `${path}.${key}`, message: "unknown key" });
    if (typeof gate !== "string") {
      errors.push({ path: `${path}.gate`, message: "must be a gate name" });
      return { id, gate: "", args: undefined };
    }
    name = gate;
    args = withArgs;
    onFail = on_fail;
  } else {
    const { on_fail, ...rest } = entry;
    const keys = Object.keys(rest);
    if (keys.length !== 1) {
      errors.push({ path, message: "must name exactly one gate, e.g. `paths_only: [...]`" });
      return { id, gate: "", args: undefined };
    }
    name = keys[0]!;
    args = rest[name];
    onFail = on_fail;
  }

  const node: GateNode = { id: `${id}:${name}`, gate: name, args: undefined };

  const gate = registry.get(name);
  if (!gate) {
    errors.push({ path, message: `unknown gate \`${name}\` (known: ${registry.names().join(", ")})` });
    return node;
  }

  // YAML `name:` with no value parses as null; treat it as "no arguments".
  const parsedArgs = gate.args.safeParse(args === null ? undefined : args);
  if (parsedArgs.success) {
    node.args = parsedArgs.data;
  } else {
    for (const issue of parsedArgs.error.issues) {
      const where = issue.path.length ? `${path}.${formatPath(issue.path)}` : path;
      errors.push({ path: where, message: `${name}: ${issue.message}` });
    }
  }

  if (onFail !== undefined) {
    const parsedOnFail = FailOutcomeSchema.safeParse(onFail);
    if (parsedOnFail.success) node.onFail = parsedOnFail.data as FailOutcome;
    else errors.push({ path: `${path}.on_fail`, message: "must be `escalate` or `block`" });
  }
  return node;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => {
    if (typeof key === "number") return `${out}[${key}]`;
    return out ? `${out}.${String(key)}` : String(key);
  }, "");
}
