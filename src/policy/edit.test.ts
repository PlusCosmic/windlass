import { describe, expect, it } from "vitest";
import { defaultGateRegistry } from "../gates/registry.js";
import { applyEdit, readGate, type PolicyEdit } from "./edit.js";
import { parsePolicy } from "./parse.js";

const SOURCE = `# Phase 1 policy.
policy: v1
defaults:
  always:
    - no_new_skips
    - gate: ci_green
      with:
        # The checks the ruleset requires.
        required: [Frontend, API]
categories:
  docs_only:
    gates:
      # Narrower than "**/*.md".
      - paths_only: ["docs/**"]
    outcome: merge

  test_only:
    gates:
      - paths_only:
          - "tests/**/*.cs"
    outcome: merge

fallback: escalate
`;

const registry = defaultGateRegistry();

function edit(...edits: PolicyEdit[]) {
  const source = edits.reduce(applyEdit, SOURCE);
  const parsed = parsePolicy(source, registry);
  if (!parsed.ok) throw new Error(`invalid after edit: ${JSON.stringify(parsed.errors)}\n${source}`);
  return { source, policy: parsed.policy };
}

describe("applyEdit", () => {
  it("keeps the comments of everything it doesn't touch", () => {
    const { source } = edit({ type: "set_fallback", outcome: "block" });
    expect(source).toBe(SOURCE.replace("fallback: escalate", "fallback: block"));
  });

  it("adds a gate to a category, or to always", () => {
    const { policy, source } = edit(
      { type: "add_gate", category: "docs_only", gate: "ci_green" },
      { type: "add_gate", category: null, gate: "paths_only", args: ["src/**"], index: 0 },
    );
    expect(policy.categories.docs_only!.gates.map((g) => g.gate)).toEqual(["paths_only", "ci_green"]);
    expect(policy.defaults.always.map((g) => g.gate)).toEqual(["paths_only", "no_new_skips", "ci_green"]);
    expect(source).toContain("# The checks the ruleset requires.");
  });

  it("creates the gate list a category doesn't have yet", () => {
    const { policy, source } = edit(
      { type: "add_category", name: "refactor" },
      { type: "add_gate", category: "refactor", gate: "paths_only", args: ["src/**"] },
    );
    expect(policy.categories.refactor).toMatchObject({ outcome: "escalate", gates: [{ args: ["src/**"] }] });
    expect(source).toContain(
      "  refactor:\n    gates:\n      - gate: paths_only\n        with:\n          - src/**\n    outcome: escalate\n",
    );
    expect(Object.keys(policy.categories)).toEqual(["docs_only", "test_only", "refactor"]);
  });

  it("sets arguments on each of the three ways a gate is written", () => {
    const { policy, source } = edit(
      {
        type: "set_gate_args",
        at: { category: null, index: 0 },
        args: { ignore_paths: ["frontend/src/api-client/**"] },
      },
      { type: "set_gate_args", at: { category: null, index: 1 }, args: { required: ["CI"] } },
      { type: "set_gate_args", at: { category: "docs_only", index: 0 }, args: ["docs/**", "**/README.md"] },
    );
    expect(policy.defaults.always[0]!.args).toMatchObject({ ignore_paths: ["frontend/src/api-client/**"] });
    expect(policy.defaults.always[1]!.args).toEqual({ required: ["CI"] });
    expect(policy.categories.docs_only!.gates[0]!.args).toEqual(["docs/**", "**/README.md"]);
    expect(source).toContain('# Narrower than "**/*.md".');
  });

  it("sets and clears on_fail", () => {
    const at = { category: "docs_only", index: 0 };
    expect(edit({ type: "set_on_fail", at, onFail: "block" }).policy.categories.docs_only!.gates[0]!.onFail).toBe(
      "block",
    );
    const cleared = edit({ type: "set_on_fail", at, onFail: "block" }, { type: "set_on_fail", at, onFail: null });
    expect(cleared.source).toBe(SOURCE);
    const bare = edit({ type: "set_on_fail", at: { category: null, index: 0 }, onFail: "escalate" });
    expect(bare.policy.defaults.always[0]).toMatchObject({ gate: "no_new_skips", onFail: "escalate" });
  });

  it("removes and moves gates", () => {
    const moved = edit({
      type: "move_gate",
      at: { category: null, index: 1 },
      to: { category: "test_only", index: 0 },
    });
    expect(moved.policy.defaults.always.map((g) => g.gate)).toEqual(["no_new_skips"]);
    expect(moved.policy.categories.test_only!.gates.map((g) => g.gate)).toEqual(["ci_green", "paths_only"]);
    expect(moved.policy.categories.test_only!.gates[0]!.args).toEqual({ required: ["Frontend", "API"] });

    const removed = edit({ type: "remove_gate", at: { category: null, index: 0 } });
    expect(removed.policy.defaults.always.map((g) => g.gate)).toEqual(["ci_green"]);
  });

  it("renames a category in place and removes one", () => {
    const { policy, source } = edit(
      { type: "rename_category", from: "docs_only", to: "docs" },
      { type: "remove_category", name: "test_only" },
      { type: "set_outcome", category: "docs", outcome: "escalate" },
    );
    expect(Object.keys(policy.categories)).toEqual(["docs"]);
    expect(policy.categories.docs!.outcome).toBe("escalate");
    expect(source).toContain('# Narrower than "**/*.md".');
  });

  it("refuses edits that can't be made", () => {
    expect(() => applyEdit(SOURCE, { type: "add_category", name: "docs_only" })).toThrow("already exists");
    expect(() => applyEdit(SOURCE, { type: "add_category", name: "Docs Only" })).toThrow("snake_case");
    expect(() => applyEdit(SOURCE, { type: "rename_category", from: "docs_only", to: "test_only" })).toThrow("already");
    expect(() => applyEdit(SOURCE, { type: "remove_gate", at: { category: null, index: 5 } })).toThrow("no gate");
    expect(() => applyEdit(SOURCE, { type: "add_gate", category: "nope", gate: "ci_green" })).toThrow(
      "not in the policy",
    );
    expect(() => applyEdit("policy: [v1", { type: "set_fallback", outcome: "block" })).toThrow("not valid YAML");
  });

  it("starts a policy from an empty file", () => {
    const source = [
      { type: "add_category", name: "docs_only" } as const,
      { type: "add_gate", category: null, gate: "ci_green" } as const,
    ].reduce(applyEdit, "policy: v1\n");
    expect(parsePolicy(source, registry)).toMatchObject({ ok: true });
  });
});

describe("readGate", () => {
  it("reads each form as written, including arguments the parser would reject", () => {
    expect(readGate(SOURCE, { category: null, index: 0 })).toEqual({
      gate: "no_new_skips",
      args: undefined,
      onFail: undefined,
    });
    expect(readGate(SOURCE, { category: null, index: 1 })).toMatchObject({
      gate: "ci_green",
      args: { required: ["Frontend", "API"] },
    });
    const broken = applyEdit(
      applyEdit(SOURCE, { type: "set_gate_args", at: { category: "docs_only", index: 0 }, args: [] }),
      { type: "set_on_fail", at: { category: "docs_only", index: 0 }, onFail: "block" },
    );
    expect(readGate(broken, { category: "docs_only", index: 0 })).toEqual({
      gate: "paths_only",
      args: [],
      onFail: "block",
    });
    expect(readGate(SOURCE, { category: "docs_only", index: 4 })).toBeNull();
    expect(readGate("policy: [v1", { category: null, index: 0 })).toBeNull();
  });
});
