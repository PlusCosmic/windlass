import { describe, expect, it } from "vitest";
import { decide } from "./engine.js";
import type { PullRequestInput } from "./facts/types.js";
import { defaultGateRegistry } from "./gates/registry.js";
import { FALLBACK_END, laneEnd, policyToGraph, ROUTER_NODE, traceDecision, type FlowGraph } from "./graph.js";
import { parsePolicy } from "./policy/parse.js";

const registry = defaultGateRegistry();

const POLICY = `
policy: v1
defaults:
  always:
    - no_new_skips
    - gate: ci_green
      on_fail: block
categories:
  docs_only:
    gates:
      - paths_only: ["**/*.md"]
    evaluators:
      - id: docs_are_accurate
        question: Do the docs describe what the code does?
        min_confidence: 0.8
    outcome: merge
  refactor:
    outcome: escalate
fallback: block
`;

function graphOf(source: string): FlowGraph {
  const parsed = parsePolicy(source, registry);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return policyToGraph(parsed.policy, registry).graph;
}

const DOCS_DIFF = ["--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-old", "+new"].join("\n");
const SRC_DIFF = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");

function pr(category: string | null, diff = DOCS_DIFF): PullRequestInput {
  return {
    baseSha: "base",
    headSha: "head",
    body: category ? `\`\`\`windlass\ncategory: ${category}\n\`\`\`` : "",
    diff,
    ci: { checks: [{ name: "build", status: "completed", conclusion: "success" }] },
  };
}

describe("policyToGraph", () => {
  const graph = graphOf(POLICY);

  it("lays the trunk out in the order the engine walks it", () => {
    const trunk = graph.nodes.filter((node) => node.lane === null && node.kind !== "outcome").map((node) => node.id);
    expect(trunk).toEqual([
      "pr",
      "policy",
      "protected_paths",
      "intent",
      "always[0]:no_new_skips",
      "always[1]:ci_green",
      ROUTER_NODE,
    ]);
  });

  it("gives each category a lane ending in its outcome, plus the fallback", () => {
    expect(graph.lanes).toEqual(["docs_only", "refactor"]);
    expect(graph.nodes.filter((node) => node.lane === "docs_only").map((node) => node.id)).toEqual([
      "docs_only[0]:paths_only",
      "docs_only.eval[0]:docs_are_accurate",
      laneEnd("docs_only"),
    ]);
    expect(graph.nodes.find((node) => node.id === laneEnd("refactor"))).toMatchObject({ outcome: "escalate" });
    expect(graph.nodes.find((node) => node.id === FALLBACK_END)).toMatchObject({ outcome: "block", fallback: true });
    // An empty lane still connects the router to its outcome.
    expect(graph.edges).toContainEqual({
      id: `${ROUTER_NODE}->${laneEnd("refactor")}`,
      source: ROUTER_NODE,
      target: laneEnd("refactor"),
      label: "refactor",
    });
  });

  it("shows what a failure contributes, and whether the policy chose it", () => {
    const [skips, ci] = graph.nodes.filter((node) => node.kind === "gate");
    expect(skips).toMatchObject({ gate: "no_new_skips", onFail: "block", onFailSet: false });
    expect(ci).toMatchObject({ gate: "ci_green", onFail: "block", onFailSet: true, ref: { category: null, index: 1 } });
  });

  it("connects every node, and only to nodes that exist", () => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(ids.size).toBe(graph.nodes.length);
    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
    const targets = new Set(graph.edges.map((edge) => edge.target));
    expect(graph.nodes.filter((node) => !targets.has(node.id)).map((node) => node.id)).toEqual(["pr"]);
  });

  it("draws a policy with a bad gate, with the errors on the gate", () => {
    const parsed = parsePolicy(POLICY.replace('paths_only: ["**/*.md"]', "paths_only: []"), registry);
    if (parsed.ok || !parsed.partial) throw new Error("expected a partial policy");
    const { graph, unplaced } = policyToGraph(parsed.partial, registry, parsed.errors);
    expect(graph.nodes.find((node) => node.id === "docs_only[0]:paths_only")?.errors).toHaveLength(1);
    expect(unplaced).toEqual([]);
  });
});

describe("traceDecision", () => {
  const graph = graphOf(POLICY);
  const trace = async (input: PullRequestInput) => traceDecision(graph, await decide(input, { policy: POLICY }));

  it("follows a PR down its category's lane", async () => {
    const result = await trace(pr("refactor"));
    expect(result.outcome).toBe("escalate");
    expect(result.nodes).toMatchObject({
      policy: "pass",
      intent: "pass",
      "always[1]:ci_green": "pass",
      [ROUTER_NODE]: "visited",
      [laneEnd("refactor")]: "visited",
    });
    expect(result.edges).toContain(`${ROUTER_NODE}->${laneEnd("refactor")}`);
    expect(result.edges).not.toContain(`${ROUTER_NODE}->${FALLBACK_END}`);
    expect(Object.keys(result.nodes).some((id) => id.startsWith("docs_only"))).toBe(false);
  });

  it("marks the gate that failed and keeps walking", async () => {
    const result = await trace(pr("docs_only", SRC_DIFF));
    expect(result.nodes["docs_only[0]:paths_only"]).toBe("fail");
    expect(result.reasons["docs_only[0]:paths_only"]).toContain("fall outside");
    // The evaluator is skipped once the PR is off the merge path, but the lane is still walked to its end.
    expect(result.nodes["docs_only.eval[0]:docs_are_accurate"]).toBe("skipped");
    expect(result.nodes[laneEnd("docs_only")]).toBe("visited");
    expect(result.edges).toContain(`docs_only.eval[0]:docs_are_accurate->${laneEnd("docs_only")}`);
  });

  it("sends an undeclared category to the fallback", async () => {
    const result = await trace(pr("feature"));
    expect(result.outcome).toBe("block");
    expect(result.nodes[FALLBACK_END]).toBe("visited");
    expect(result.edges).toContain(`${ROUTER_NODE}->${FALLBACK_END}`);
  });

  it("stops before the router when the PR declares nothing", async () => {
    const result = await trace(pr(null));
    expect(result.nodes.intent).toBe("fail");
    expect(result.reasons.intent).toContain("no `windlass` block");
    // The always-gates still run and are recorded.
    expect(result.nodes["always[0]:no_new_skips"]).toBe("pass");
    expect(ROUTER_NODE in result.nodes).toBe(false);
  });
});
