import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { defaultGateRegistry } from "../src/gates/registry.js";
import { parsePolicy } from "../src/policy/parse.js";

it("examples/policy.yaml is a valid policy", () => {
  const source = readFileSync(new URL("../examples/policy.yaml", import.meta.url), "utf8");
  const result = parsePolicy(source, defaultGateRegistry());
  expect(result.ok ? [] : result.errors).toEqual([]);
});
