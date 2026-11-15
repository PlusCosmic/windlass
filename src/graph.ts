import type { DecisionOutcome, DecisionRecord, EvaluatorStatus } from "./decision.js";
import type { GateRegistry } from "./gates/registry.js";
import type { GateStatus } from "./gates/types.js";
import type { PolicyError } from "./policy/parse.js";
import type { FailOutcome, Outcome, Policy } from "./policy/types.js";

/**
 * The policy as a flowchart: what the editor draws and a decision is traced over.
 *
 * It is a view of the walk `decide` does, not a second policy format. Every PR
 * runs down the trunk (the built-in checks, then the always-gates), the router
 * sends it to its declared category's lane or to the fallback, and a lane ends
 * in that category's outcome.
 *
 * A failed node doesn't end the walk. It takes the PR off the merge path, the
 * rest of the nodes still run and are recorded, and the most severe result wins.
 * So `onFail` is a property of the node here, not an edge to somewhere else.
 */
export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Category names in file order: one lane each, top to bottom. */
  lanes: string[];
}

/** Where a gate sits in the policy file: `category: null` is `defaults.always`. */
export interface GateRef {
  category: string | null;
  index: number;
}

/** Where an evaluator sits in the policy file: `categories.<category>.evaluators[index]`. */
export interface EvaluatorRef {
  category: string;
  index: number;
}

interface NodeBase {
  /** The id `DecisionRecord.path` uses for this node, where the engine has one. */
  id: string;
  /** The category lane the node is in; null on the trunk. */
  lane: string | null;
  /** Problems the policy file has at this node. */
  errors: string[];
}

export type FlowNode =
  | (NodeBase & { kind: "start" })
  | (NodeBase & { kind: "builtin"; check: "policy" | "protected_paths" | "intent" })
  | (NodeBase & {
      kind: "gate";
      ref: GateRef;
      gate: string;
      description: string;
      args: unknown;
      /** What a failure contributes: the policy's `on_fail`, or the gate's default. */
      onFail: FailOutcome;
      /** True when the policy sets `on_fail` itself. */
      onFailSet: boolean;
    })
  | (NodeBase & { kind: "router" })
  | (NodeBase & {
      kind: "evaluator";
      ref: EvaluatorRef;
      evaluator: string;
      /** The question as it will be asked, before its placeholders are filled. */
      question: string;
      /** True when the policy leaves the question to the built-in one for this name. */
      questionFromPreset: boolean;
      minConfidence: number;
      model: string | null;
    })
  | (NodeBase & { kind: "outcome"; outcome: Outcome; fallback: boolean });

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** Set on the router's edges: the category name. */
  label?: string;
}

export const START_NODE = "pr";
export const ROUTER_NODE = "category";
export const FALLBACK_END = "end";

/** The id of the outcome node a category's lane ends in. */
export function laneEnd(category: string): string {
  return `end:${category}`;
}

/**
 * Draws a policy. `errors` are attached to the nodes they are about (a partial
 * policy from `parsePolicy` has some), and anything left over is returned so
 * the caller can show it against the file as a whole.
 */
export function policyToGraph(
  policy: Policy,
  registry: GateRegistry,
  errors: readonly PolicyError[] = [],
): { graph: FlowGraph; unplaced: PolicyError[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const remaining = [...errors];

  /** Takes the errors at or under a path in the policy file. */
  const errorsAt = (path: string): string[] => {
    const taken: string[] = [];
    for (let i = remaining.length - 1; i >= 0; i--) {
      const error = remaining[i]!;
      if (error.path === path || error.path.startsWith(`${path}.`) || error.path.startsWith(`${path}[`)) {
        taken.unshift(error.message);
        remaining.splice(i, 1);
      }
    }
    return taken;
  };

  const link = (source: string, target: string, label?: string) => {
    edges.push({ id: `${source}->${target}`, source, target, ...(label !== undefined && { label }) });
  };

  const gateNode = (ref: GateRef, path: string): FlowNode => {
    const node =
      ref.category === null ? policy.defaults.always[ref.index]! : policy.categories[ref.category]!.gates[ref.index]!;
    const gate = registry.get(node.gate);
    return {
      kind: "gate",
      id: node.id,
      lane: ref.category,
      ref,
      gate: node.gate,
      description: gate?.description ?? "",
      args: node.args,
      onFail: node.onFail ?? gate?.defaultOnFail ?? "escalate",
      onFailSet: node.onFail !== undefined,
      errors: errorsAt(path),
    };
  };

  nodes.push({ kind: "start", id: START_NODE, lane: null, errors: [] });
  let previous = START_NODE;
  for (const check of ["policy", "protected_paths", "intent"] as const) {
    nodes.push({ kind: "builtin", id: check, lane: null, check, errors: [] });
    link(previous, check);
    previous = check;
  }

  policy.defaults.always.forEach((_, index) => {
    const node = gateNode({ category: null, index }, `defaults.always[${index}]`);
    nodes.push(node);
    link(previous, node.id);
    previous = node.id;
  });

  nodes.push({ kind: "router", id: ROUTER_NODE, lane: null, errors: [] });
  link(previous, ROUTER_NODE);

  const lanes = Object.keys(policy.categories);
  for (const name of lanes) {
    const category = policy.categories[name]!;
    let last = ROUTER_NODE;
    const step = (id: string) => {
      link(last, id, last === ROUTER_NODE ? name : undefined);
      last = id;
    };

    category.gates.forEach((_, index) => {
      const node = gateNode({ category: name, index }, `categories.${name}.gates[${index}]`);
      nodes.push(node);
      step(node.id);
    });
    category.evaluators.forEach((evaluator, index) => {
      nodes.push({
        kind: "evaluator",
        id: evaluator.id,
        lane: name,
        ref: { category: name, index },
        evaluator: evaluator.evaluator,
        question: evaluator.question,
        questionFromPreset: evaluator.questionFromPreset,
        minConfidence: evaluator.minConfidence,
        model: evaluator.model ?? null,
        errors: errorsAt(`categories.${name}.evaluators[${index}]`),
      });
      step(evaluator.id);
    });

    const end = laneEnd(name);
    nodes.push({
      kind: "outcome",
      id: end,
      lane: name,
      outcome: category.outcome,
      fallback: false,
      errors: errorsAt(`categories.${name}`),
    });
    step(end);
  }

  nodes.push({
    kind: "outcome",
    id: FALLBACK_END,
    lane: null,
    outcome: policy.fallback,
    fallback: true,
    errors: errorsAt("fallback"),
  });
  link(ROUTER_NODE, FALLBACK_END);

  return { graph: { nodes, edges, lanes }, unplaced: remaining };
}

/** How a node came out for one PR. `visited` is a node with no result of its own. */
export type TraceStatus = GateStatus | EvaluatorStatus | "visited";

export interface Trace {
  outcome: DecisionOutcome;
  /** Status per node the PR reached. Nodes it never reached are absent. */
  nodes: Record<string, TraceStatus>;
  /** Ids of the edges the PR travelled. */
  edges: string[];
  /** Why each node took the PR off the merge path, where it gave a reason. */
  reasons: Record<string, string>;
}

/** Lays a decision over the graph of the policy that made it. */
export function traceDecision(graph: FlowGraph, record: DecisionRecord): Trace {
  const nodes: Record<string, TraceStatus> = { [START_NODE]: "visited" };
  const reasons: Record<string, string> = {};

  for (const builtin of record.builtins) {
    nodes[builtin.node] = builtin.status;
    if (builtin.reason) reasons[builtin.node] = builtin.reason;
  }
  for (const gate of record.gates) {
    nodes[gate.node] = gate.status;
    reasons[gate.node] = gate.reason;
  }
  for (const evaluator of record.evaluators) {
    nodes[evaluator.node] = evaluator.status;
    reasons[evaluator.node] = evaluator.reason;
  }

  for (const step of record.path) {
    if (step === "fallback") {
      nodes[ROUTER_NODE] = "visited";
      nodes[FALLBACK_END] = "visited";
    } else if (step.startsWith("category:")) {
      nodes[ROUTER_NODE] = "visited";
    } else if (step.startsWith("outcome:") && record.category !== null) {
      nodes[laneEnd(record.category)] = "visited";
    }
  }

  // A skipped evaluator was never reached, though the lane's end beyond it was.
  const reached = (id: string) => id in nodes && nodes[id] !== "skipped";
  for (const evaluator of record.evaluators) {
    if (evaluator.status === "skipped") delete reasons[evaluator.node];
  }
  const known = new Set(graph.nodes.map((node) => node.id));
  for (const id of Object.keys(nodes)) if (!known.has(id)) delete nodes[id];

  const edges: string[] = [];
  for (const edge of graph.edges) {
    if (reached(edge.source) && reached(edge.target)) edges.push(edge.id);
  }
  // Bridge skipped evaluators so the lane still reads as travelled to its end.
  if (record.category !== null && laneEnd(record.category) in nodes) {
    for (const edge of graph.edges) {
      const lane = graph.nodes.find((node) => node.id === edge.target)?.lane;
      if (lane === record.category && !edges.includes(edge.id)) edges.push(edge.id);
    }
  }

  return { outcome: record.outcome, nodes, edges, reasons };
}
