import { traceDecision, type FlowGraph, type Trace } from "../../src/graph";
import type { SimulatedPull } from "./api";

/** How the replayed pull requests fared at one node, under the draft. */
export interface NodeTally {
  reached: number;
  /** Took the PR off the merge path here: a failure, an error or an unsure evaluator. */
  off: number[];
  pending: number;
  /** Reached an evaluator nobody has an answer from. It escalates, but says nothing about the pull request. */
  notRun: number;
}

export interface Replay {
  /** Each pull request's path through the draft policy, by number. */
  traces: Map<number, Trace>;
  nodes: Record<string, NodeTally>;
  /** How many pull requests travelled each edge. */
  edges: Record<string, number>;
}

const OFF_PATH = new Set(["fail", "error", "low_confidence"]);

/** Lays every replayed pull request over the graph and counts what happened where. */
export function replay(graph: FlowGraph, pulls: readonly SimulatedPull[]): Replay {
  const traces = new Map<number, Trace>();
  const nodes: Record<string, NodeTally> = {};
  const edges: Record<string, number> = {};

  for (const pull of pulls) {
    const trace = traceDecision(graph, pull.draft);
    traces.set(pull.number, trace);
    for (const [id, status] of Object.entries(trace.nodes)) {
      if (status === "skipped") continue;
      const tally = (nodes[id] ??= { reached: 0, off: [], pending: 0, notRun: 0 });
      tally.reached++;
      if (OFF_PATH.has(status)) tally.off.push(pull.number);
      if (status === "pending") tally.pending++;
      if (status === "not_run") tally.notRun++;
    }
    for (const id of trace.edges) edges[id] = (edges[id] ?? 0) + 1;
  }
  return { traces, nodes, edges };
}

export type OutcomeCounts = Record<"merge" | "escalate" | "block" | "pending", number>;

export function countOutcomes(pulls: readonly SimulatedPull[], which: "current" | "draft"): OutcomeCounts {
  const counts: OutcomeCounts = { merge: 0, escalate: 0, block: 0, pending: 0 };
  for (const pull of pulls) counts[pull[which].outcome]++;
  return counts;
}

/** Categories the pull requests declared that the draft has no lane for, most declared first. */
export function undefinedCategories(graph: FlowGraph, pulls: readonly SimulatedPull[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const pull of pulls) {
    const category = pull.draft.intent?.category;
    if (category !== undefined && !graph.lanes.includes(category))
      counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
