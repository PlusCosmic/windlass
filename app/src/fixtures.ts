import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decide } from "../../src/index.js";
import { listFixtures, loadFixture, stubRunner } from "../../src/harness.js";
import type { Evaluations } from "./evaluations.js";
import type { Store } from "./store.js";

/**
 * Dev mode: loads the engine's test fixtures as a repository of sample PRs, so
 * the editor has something to replay without reaching GitHub. The verdicts a
 * case stubs are stored as if a runner had given them, so its evaluators show
 * an answer without a model being asked.
 */
export async function seedFixtures(
  store: Store,
  dir: string,
  evaluations: Evaluations | null = null,
  now: Date = new Date(),
): Promise<number> {
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

  if (evaluations) {
    for (const fixture of fixtures) {
      if (!fixture.verdicts) continue;
      const stub = stubRunner(fixture.verdicts);
      await decide(fixture.input, {
        policy: fixture.policySource,
        evaluators: {
          async run(request, signal) {
            const response = await stub.run(request, signal);
            evaluations.seed(request, response);
            return response;
          },
        },
      });
    }
  }
  return fixtures.length;
}
