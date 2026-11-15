import { beforeEach, describe, expect, it } from "vitest";
import { checkFor } from "./port.js";
import { Service, ServiceError } from "./service.js";
import { Store, type Repo } from "./store.js";
import { accessTo, DOCS_DIFF, FakeGitHub, POLICY, pull, SRC_DIFF } from "./testing.js";

let store: Store;
let github: FakeGitHub;
let repo: Repo;
let service: Service;

beforeEach(() => {
  store = new Store(":memory:");
  github = new FakeGitHub().add(pull(1)).add(pull(2), SRC_DIFF);
  repo = store.upsertRepo("acme", "app", 5);
  service = new Service({
    store,
    github: accessTo(github),
    policyPath: ".windlass/policy.yaml",
    baseUrl: "https://windlass.example",
    now: () => new Date(0),
  });
});

describe("judge", () => {
  it("reports the decision on GitHub and keeps the PR for replay", async () => {
    const decision = await service.judge(repo, 1);
    expect(decision?.outcome).toBe("merge");
    expect(github.labels.get(1)).toEqual(["windlass/would-merge"]);
    expect(github.comments.get(1)?.body).toContain("Would merge (shadow mode");
    expect(github.reports).toEqual([
      {
        sha: pull(1).headSha,
        check: expect.objectContaining({
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://windlass.example/?repo=acme%2Fapp&pr=1",
        }),
      },
    ]);

    const [stored] = store.listPulls(repo.id);
    expect(stored).toMatchObject({ number: 1, title: "PR 1", state: "open", decision: { outcome: "merge" } });
    expect(stored!.input.diff).toBe(DOCS_DIFF);
    expect(store.countDecisions(repo.id)).toBe(1);
  });

  it("never reports a failing check: shadow mode holds nothing up", async () => {
    github.diffs.set(1, ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", '+it.only("x", () => {});'].join("\n"));
    const decision = await service.judge(repo, 1);
    expect(decision?.outcome).toBe("block");
    expect(github.reports[0]?.check).toMatchObject({ conclusion: "neutral", title: "Blocked (shadow mode)" });
  });

  it("reports an in-progress check while CI runs, and logs no decision as final", async () => {
    github.checks = [{ name: "test", status: "in_progress" }];
    await service.judge(repo, 1);
    expect(github.reports[0]?.check).toMatchObject({ status: "in_progress", title: "Waiting on CI" });
    expect(github.comments.size).toBe(0);
  });

  it("skips a closed PR without reporting anything", async () => {
    github.add(pull(3, { state: "closed" }));
    expect(await service.judge(repo, 3)).toBeNull();
    expect(github.reports).toEqual([]);
    expect(store.listPulls(repo.id)).toEqual([]);
  });

  it("refuses when it can't write, as in dev mode", async () => {
    const readOnly = new Service({ store, github: accessTo(github, false), policyPath: ".windlass/policy.yaml" });
    await expect(readOnly.judge(repo, 1)).rejects.toThrow(ServiceError);
    expect(github.comments.size).toBe(0);
  });
});

describe("checkFor", () => {
  it("keeps attacker-controlled reasons out of the check run", async () => {
    await service.judge(repo, 2);
    const decision = store.listPulls(repo.id)[0]!.decision!;
    expect(decision.reasons).toHaveLength(1);
    const check = checkFor(decision);
    expect(check.summary).toBe("1 reason; see Windlass's comment on the pull request.");
    expect(`${check.title} ${check.summary}`).not.toContain(decision.reasons[0]);
  });
});

describe("importPulls", () => {
  it("stores PRs and the policy without writing to GitHub", async () => {
    github.add(pull(3, { state: "closed", merged: true }));
    expect(await service.importPulls(repo, 10)).toBe(3);
    expect(store.listPulls(repo.id).map((p) => [p.number, p.state, p.decision])).toEqual([
      [3, "merged", null],
      [2, "open", null],
      [1, "open", null],
    ]);
    expect(store.getRepo("acme", "app")?.policySource).toBe(POLICY);
    expect(github.comments.size + github.reports.length + github.labels.size).toBe(0);
  });

  it("keeps a reported decision until the head moves", async () => {
    await service.judge(repo, 1);
    await service.importPulls(repo, 10);
    expect(store.listPulls(repo.id).find((p) => p.number === 1)?.decision?.outcome).toBe("merge");

    github.pulls.get(1)!.headSha = "f".repeat(40);
    await service.importPulls(repo, 10);
    expect(store.listPulls(repo.id).find((p) => p.number === 1)?.decision).toBeNull();
  });
});

describe("simulate", () => {
  const draft = POLICY.replace('paths_only: ["**/*.md"]', 'paths_only: ["**/*.md", "src/**"]');

  beforeEach(async () => {
    await service.importPulls(repo, 10);
    repo = store.getRepo("acme", "app")!;
  });

  it("decides every PR under the current policy and the draft", async () => {
    const result = await service.simulate(repo, draft);
    expect(result.policy.ok).toBe(true);
    expect(result.pulls.map((p) => [p.number, p.current.outcome, p.draft.outcome])).toEqual([
      [2, "escalate", "merge"],
      [1, "merge", "merge"],
    ]);
    expect(result.graph?.lanes).toEqual(["docs_only"]);
  });

  it("with no draft, shows the current policy", async () => {
    const result = await service.simulate(repo, null);
    expect(result.pulls.every((p) => p.draft === p.current)).toBe(true);
    expect(result.graph).not.toBeNull();
  });

  it("escalates everything under an invalid draft, and still draws what it can", async () => {
    const result = await service.simulate(repo, POLICY.replace('["**/*.md"]', "[]"));
    expect(result.policy).toMatchObject({ ok: false, errors: [{ path: "categories.docs_only.gates[0]" }] });
    expect(result.pulls.map((p) => p.draft.outcome)).toEqual(["escalate", "escalate"]);
    expect(result.graph?.nodes.find((n) => n.id === "docs_only[0]:paths_only")?.errors).toHaveLength(1);
    expect(result.unplaced).toEqual([]);
  });

  it("reports a draft that isn't a policy at all", async () => {
    const result = await service.simulate(repo, "policy: [v1");
    expect(result).toMatchObject({ policy: { ok: false }, graph: null });
    expect(result.unplaced).toHaveLength(1);
  });

  it("says so when the repo has no policy", async () => {
    github.policy = null;
    await service.refreshPolicy(repo);
    const result = await service.simulate(store.getRepo("acme", "app")!, null);
    expect(result.policy.errors[0]?.message).toContain("has no policy");
    expect(result.pulls.map((p) => p.current.outcome)).toEqual(["escalate", "escalate"]);
  });

  it("proposes a valid, changed policy as a pull request listing what changes", async () => {
    expect(await service.proposePolicy(repo, draft)).toBe("https://github.com/acme/app/pull/99");
    expect(github.proposals).toHaveLength(1);
    expect(github.proposals[0]).toMatchObject({ path: ".windlass/policy.yaml", content: draft });
    expect(github.proposals[0]!.branch).toMatch(/^windlass\/policy-[0-9a-f]{10}$/);
    expect(github.proposals[0]!.body).toContain("- #2: escalate → merge");
  });

  it("refuses to propose an invalid or unchanged policy", async () => {
    await expect(service.proposePolicy(repo, "policy: v2")).rejects.toThrow("invalid");
    await expect(service.proposePolicy(repo, POLICY)).rejects.toThrow("unchanged");
    expect(github.proposals).toEqual([]);
  });
});

describe("catalog", () => {
  it("describes each gate's arguments as JSON Schema", () => {
    const gates = Object.fromEntries(service.catalog().map((gate) => [gate.name, gate]));
    expect(Object.keys(gates).sort()).toEqual(["ci_green", "no_new_skips", "paths_only"]);
    expect(gates.paths_only).toMatchObject({
      defaultOnFail: "escalate",
      args: { type: "array", items: { type: "string" } },
    });
    expect(gates.no_new_skips?.defaultOnFail).toBe("block");
  });
});
