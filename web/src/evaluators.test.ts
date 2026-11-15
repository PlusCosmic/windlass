import { describe, expect, it } from "vitest";
import type { EvaluatorRecord } from "../../src/decision.js";
import type { SimulatedPull } from "./api.js";
import { evaluatorId, evaluatorRuns, formatConfidence, readEvaluator } from "./evaluators.js";

const NODE = evaluatorId("flagged_feature", 0, "fully_flag_gated");

function pull(number: number, record: Partial<EvaluatorRecord> | null): SimulatedPull {
  const evaluators: EvaluatorRecord[] = record
    ? [
        {
          node: NODE,
          evaluator: "fully_flag_gated",
          status: "pass",
          model: null,
          minConfidence: 0.85,
          verdict: null,
          confidence: null,
          reason: "",
          evidence: [],
          ...record,
        },
      ]
    : [];
  // Only the draft's evaluators are read.
  const decision = { evaluators } as SimulatedPull["draft"];
  return { number, title: `PR ${number}`, author: "a", state: "open", headSha: "", current: decision, draft: decision };
}

describe("evaluatorRuns", () => {
  const pulls = [
    pull(1, { status: "pass", verdict: "pass", confidence: 0.93 }),
    pull(2, { status: "fail", verdict: "fail", confidence: 0.96 }),
    pull(3, { status: "low_confidence", verdict: "pass", confidence: 0.6 }),
    pull(4, { status: "not_run", reason: "not run yet" }),
    pull(5, { status: "not_run", reason: "waiting for the runner" }),
    pull(6, { status: "not_run", reason: "no evaluator runner is connected" }),
    pull(7, { status: "error", reason: "evaluator returned malformed output" }),
    pull(8, { status: "skipped", reason: "not run: the PR is already off the merge path" }),
    pull(9, null),
  ];
  const { runs, counts, runnable } = evaluatorRuns(NODE, pulls);

  it("counts the pull requests that reached the evaluator, by how it came out", () => {
    expect(runs.map((run) => run.pull.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(counts).toEqual({ pass: 1, fail: 1, low_confidence: 1, not_run: 3, error: 1 });
  });

  it("offers to run the ones with no answer that aren't already with the runner", () => {
    expect(runnable).toBe(2);
    expect(runs.filter((run) => run.waiting).map((run) => run.pull.number)).toEqual([5]);
  });

  it("knows nothing of another node", () => {
    expect(evaluatorRuns(evaluatorId("flagged_feature", 1, "other"), pulls).runs).toEqual([]);
  });
});

describe("readEvaluator", () => {
  const source = `
policy: v1
categories:
  flagged_feature:
    evaluators:
      - id: fully_flag_gated
        min_confidence: 0.85
      - id: own
        question: |
          Is it behind \`{{flag}}\`?
        min_confidence: 0.9
        model: some-model
    outcome: merge
`;

  it("reads what the file gives, and null for what it leaves to the defaults", () => {
    expect(readEvaluator(source, { category: "flagged_feature", index: 0 })).toEqual({
      question: null,
      minConfidence: 0.85,
      model: null,
    });
    expect(readEvaluator(source, { category: "flagged_feature", index: 1 })).toEqual({
      question: "Is it behind `{{flag}}`?\n",
      minConfidence: 0.9,
      model: "some-model",
    });
  });

  it("is null where there is no evaluator, or no YAML to read", () => {
    expect(readEvaluator(source, { category: "flagged_feature", index: 2 })).toBeNull();
    expect(readEvaluator(source, { category: "docs_only", index: 0 })).toBeNull();
    expect(readEvaluator("categories: [", { category: "flagged_feature", index: 0 })).toBeNull();
  });
});

describe("formatConfidence", () => {
  it("shows two places at most", () => {
    expect([0.85, 0.9, 1, 0.9312, 0.6000000000000001].map(formatConfidence)).toEqual([
      "0.85",
      "0.9",
      "1",
      "0.93",
      "0.6",
    ]);
  });
});
