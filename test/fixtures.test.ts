import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listFixtures, runFixture } from "../src/harness.js";

const root = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("fixtures", () => {
  const dirs = listFixtures(root);

  it("finds fixtures", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const dir of dirs) {
    const name = dir.slice(root.length + 1);
    it(name, async () => {
      const { mismatches } = await runFixture(dir);
      expect(mismatches).toEqual([]);
    });
  }
});
