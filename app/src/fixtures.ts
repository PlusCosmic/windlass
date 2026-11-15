import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listFixtures, loadFixture } from "../../src/harness.js";
import type { Store } from "./store.js";

/**
 * Dev mode: loads the engine's test fixtures as a repository of sample PRs, so
 * the editor has something to replay without reaching GitHub.
 */
export function seedFixtures(store: Store, dir: string, now: Date = new Date()): number {
  const policyPath = join(dir, "policy.yaml");
  if (!existsSync(policyPath)) return 0;

  const repo = store.upsertRepo("windlass", "fixtures");
  store.setPolicySource(repo.id, readFileSync(policyPath, "utf8"));
  const fixtures = listFixtures(dir).map(loadFixture);
  fixtures.forEach((fixture, index) => {
    store.savePull({
      repoId: repo.id,
      number: index + 1,
      title: fixture.description ?? fixture.name.replaceAll("-", " "),
      author: "fixture",
      state: "open",
      headSha: fixture.input.headSha,
      input: fixture.input,
      decision: null,
      updatedAt: now.toISOString(),
    });
  });
  return fixtures.length;
}
