import { describe, expect, it } from "vitest";
import { defaultGateRegistry } from "../../src/gates/registry.js";
import { FALLBACK_END, laneEnd, policyToGraph, ROUTER_NODE } from "../../src/graph.js";
import { parsePolicy } from "../../src/policy/parse.js";
import { layoutGraph, type Box } from "./layout.js";

const registry = defaultGateRegistry();

function layoutOf(source: string) {
  const parsed = parsePolicy(source, registry);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const { graph } = policyToGraph(parsed.policy, registry);
  return { graph, ...layoutGraph(graph) };
}

const POLICY = `
policy: v1
defaults:
  always: [no_new_skips, ci_green]
categories:
  docs_only:
    gates:
      - paths_only: ["docs/**"]
      - ci_green
    outcome: merge
  test_only:
    gates:
      - paths_only: ["tests/**"]
    outcome: merge
  refactor:
    outcome: escalate
`;

/** With no always-gates, the trunk's last node before the router is the intent check. */
const START_GATES_END = "intent";

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("layoutGraph", () => {
  const { graph, boxes, addOn } = layoutOf(POLICY);

  it("places every node, and none on top of another", () => {
    const placed = graph.nodes.map((node) => boxes[node.id]);
    expect(placed.every(Boolean)).toBe(true);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i]!, placed[j]!), `${graph.nodes[i]!.id} over ${graph.nodes[j]!.id}`).toBe(false);
      }
    }
  });

  it("runs the trunk down one column and each lane along one row", () => {
    const trunk = graph.nodes
      .filter((node) => node.lane === null && node.kind !== "outcome")
      .map((node) => boxes[node.id]!);
    expect(new Set(trunk.map((box) => box.x)).size).toBe(1);
    expect(trunk.map((box) => box.y)).toEqual([...trunk.map((box) => box.y)].sort((a, b) => a - b));

    for (const lane of graph.lanes) {
      const row = graph.nodes.filter((node) => node.lane === lane).map((node) => boxes[node.id]!);
      expect(new Set(row.map((box) => box.y)).size).toBe(1);
    }
  });

  it("lines the outcomes up, and centres the lanes on the router", () => {
    const ends = [...graph.lanes.map(laneEnd), FALLBACK_END].map((id) => boxes[id]!);
    expect(new Set(ends.map((box) => box.x)).size).toBe(1);
    const router = boxes[ROUTER_NODE]!;
    const middle = (ends[0]!.y + ends.at(-1)!.y + ends[0]!.height) / 2;
    expect(middle).toBeCloseTo(router.y + router.height / 2);
  });

  it("offers a gate at the end of the always-gates and of each category's", () => {
    expect(addOn).toEqual({
      [`always[1]:ci_green->${ROUTER_NODE}`]: null,
      [`docs_only[1]:ci_green->${laneEnd("docs_only")}`]: "docs_only",
      [`test_only[0]:paths_only->${laneEnd("test_only")}`]: "test_only",
      // A category with no gates yet: the edge from the router straight to its outcome.
      [`${ROUTER_NODE}->${laneEnd("refactor")}`]: "refactor",
    });
  });
});

describe("layoutGraph with evaluators", () => {
  const { graph, boxes, addOn } = layoutOf(`
policy: v1
categories:
  flagged_feature:
    gates:
      - flag_referenced
    evaluators:
      - id: fully_flag_gated
        min_confidence: 0.85
      - id: no_new_endpoints
        question: Does the diff add no HTTP endpoint?
        min_confidence: 0.9
    outcome: merge
  asked_only:
    evaluators:
      - id: fully_flag_gated
        min_confidence: 0.85
    outcome: merge
`);

  it("runs a lane's evaluators along its row, after its gates and before its outcome", () => {
    const row = graph.nodes.filter((node) => node.lane === "flagged_feature");
    expect(row.map((node) => node.kind)).toEqual(["gate", "evaluator", "evaluator", "outcome"]);
    const placed = row.map((node) => boxes[node.id]!);
    expect(new Set(placed.map((box) => box.y)).size).toBe(1);
    expect(placed.map((box) => box.x)).toEqual([...placed.map((box) => box.x)].sort((a, b) => a - b));
    expect(new Set(placed.map((box) => box.x)).size).toBe(placed.length);
  });

  it("offers one add per lane, where its gates end and its evaluators begin", () => {
    expect(addOn).toEqual({
      [`${START_GATES_END}->${ROUTER_NODE}`]: null,
      "flagged_feature[0]:flag_referenced->flagged_feature.eval[0]:fully_flag_gated": "flagged_feature",
      // No gates: the edge from the router to the lane's first evaluator.
      [`${ROUTER_NODE}->asked_only.eval[0]:fully_flag_gated`]: "asked_only",
    });
  });
});
