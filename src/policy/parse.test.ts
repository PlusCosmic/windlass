import { describe, expect, it } from "vitest";
import { defaultGateRegistry } from "../gates/registry.js";
import { parsePolicy } from "./parse.js";

const registry = defaultGateRegistry();

describe("parsePolicy", () => {
  it("normalizes every gate form and keeps category order", () => {
    const result = parsePolicy(
      `
policy: v1
defaults:
  always:
    - gate: ci_green
      with: { ignore: [windlass] }
    - no_new_skips
categories:
  test_only:
    gates:
      - paths_only: ["**/test/**"]
        on_fail: block
    outcome: merge
  docs_only:
    gates:
      - paths_only: ["**/*.md"]
    evaluators:
      - id: docs_are_accurate
        min_confidence: 0.8
        model: claude-haiku-5-5
    outcome: merge
`,
      registry,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { policy } = result;
    expect(policy.fallback).toBe("escalate");
    expect(policy.defaults.always).toEqual([
      { id: "always[0]:ci_green", gate: "ci_green", args: { ignore: ["windlass"] } },
      { id: "always[1]:no_new_skips", gate: "no_new_skips", args: undefined },
    ]);
    expect(Object.keys(policy.categories)).toEqual(["test_only", "docs_only"]);
    expect(policy.categories.test_only?.gates).toEqual([
      { id: "test_only[0]:paths_only", gate: "paths_only", args: ["**/test/**"], onFail: "block" },
    ]);
    expect(policy.categories.docs_only?.evaluators).toEqual([
      {
        id: "docs_only.eval[0]:docs_are_accurate",
        evaluator: "docs_are_accurate",
        minConfidence: 0.8,
        model: "claude-haiku-5-5",
      },
    ]);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports gates the engine doesn't have", () => {
    // The sketch names gates that aren't built yet; they must be reported, not skipped.
    const result = parsePolicy(
      `
policy: v1
categories:
  bugfix:
    gates: [linked_issue, new_test_fails_on_base]
    outcome: merge
`,
      registry,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual(["categories.bugfix.gates[0]", "categories.bugfix.gates[1]"]);
    expect(result.errors[0]?.message).toMatch(/unknown gate `linked_issue`/);
  });

  it.each([
    ["invalid YAML", "policy: [", /invalid YAML/],
    ["wrong version", "policy: v2\ncategories: {}", /must be `v1`/],
    ["unknown top-level key", "policy: v1\ncategories: {}\nshadow: true", /shadow/],
    ["missing outcome", "policy: v1\ncategories:\n  docs_only: {}", /outcome/],
    ["outcome typo", "policy: v1\ncategories:\n  docs_only:\n    outcome: merged", /outcome/],
    [
      "bad gate args",
      "policy: v1\ncategories:\n  docs_only:\n    gates:\n      - paths_only: []\n    outcome: merge",
      /paths_only/,
    ],
    [
      "unknown gate arg",
      "policy: v1\ndefaults:\n  always:\n    - ci_green: { requird: [build] }\ncategories: {}",
      /requird/,
    ],
    [
      "two gates in one entry",
      "policy: v1\ncategories:\n  a:\n    gates:\n      - { ci_green: null, no_new_skips: null }\n    outcome: merge",
      /exactly one gate/,
    ],
    [
      "bad on_fail",
      "policy: v1\ndefaults:\n  always:\n    - gate: ci_green\n      on_fail: merge\ncategories: {}",
      /on_fail/,
    ],
    [
      "confidence out of range",
      "policy: v1\ncategories:\n  a:\n    evaluators: [{ id: x, min_confidence: 2 }]\n    outcome: merge",
      /min_confidence/,
    ],
    ["evaluator errors that merge", "policy: v1\ndefaults:\n  on_evaluator_error: merge\ncategories: {}", /escalate/],
    [
      "bad regex in no_new_skips",
      "policy: v1\ndefaults:\n  always:\n    - no_new_skips: { extra: ['('] }\ncategories: {}",
      /regular expression/,
    ],
  ])("rejects %s", (_, source, pattern) => {
    const result = parsePolicy(source, registry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => `${e.path} ${e.message}`).join("\n")).toMatch(pattern);
  });
});
