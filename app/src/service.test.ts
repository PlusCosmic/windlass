import { beforeEach, describe, expect, it } from "vitest";
import { Evaluations, hashRunnerToken } from "./evaluations.js";
import { checkFor } from "./port.js";
import { Service, ServiceError } from "./service.js";
import { Store, type Repo, type Runner } from "./store.js";
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
    expect(Object.keys(gates).sort()).toEqual([
      "ci_green",
      "flag_referenced",
      "no_new_skips",
      "paths_none",
      "paths_only",
    ]);
    expect(gates.paths_only).toMatchObject({
      defaultOnFail: "escalate",
      args: { type: "array", items: { type: "string" } },
    });
    expect(gates.no_new_skips?.defaultOnFail).toBe("block");
  });
});

describe("evaluators", () => {
  const FLAGGED_POLICY = `policy: v1
defaults:
  always: [ci_green]
categories:
  flagged_feature:
    gates:
      - flag_referenced
    evaluators:
      - id: fully_flag_gated
        min_confidence: 0.8
    outcome: merge
`;
  const FLAG_DIFF = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", '+if (flag("clip_search")) go();'].join(
    "\n",
  );
  const body = "```windlass\ncategory: flagged_feature\nflag: clip_search\n```";
  const verdict = (v: "pass" | "fail") => ({
    verdict: v,
    confidence: 0.95,
    evidence: [{ file: "src/a.ts", line: 1, detail: "checked" }],
  });

  let evaluations: Evaluations;
  let runner: Runner;

  beforeEach(() => {
    github = new FakeGitHub().add(pull(1, { body }), FLAG_DIFF).add(pull(2, { body }), FLAG_DIFF.replace("go", "run"));
    github.policy = FLAGGED_POLICY;
    evaluations = new Evaluations({ store });
    runner = store.upsertRunner("r", hashRunnerToken("t".repeat(32)), null);
    service = new Service({ store, github: accessTo(github), policyPath: ".windlass/policy.yaml", evaluations });
    store.setPolicySource(repo.id, FLAGGED_POLICY);
    repo = store.getRepo("acme", "app")!;
  });

  /** Answers whatever is queued, as a runner would. */
  async function answerAll(v: "pass" | "fail"): Promise<number> {
    let answered = 0;
    for (let job = await evaluations.claim(runner, ["m"], 0); job; job = await evaluations.claim(runner, ["m"], 0)) {
      evaluations.complete(runner, job.id, { ok: true, model: "m", output: verdict(v) });
      answered++;
    }
    return answered;
  }

  it("waits for the runner's verdict when judging a live PR", async () => {
    await evaluations.claim(runner, ["m"], 0);
    const judging = service.judge(repo, 1);
    const job = await evaluations.claim(runner, ["m"], 5_000);
    expect(job!.user).toContain("feature flag `clip_search`");
    expect(job!.user).not.toContain("windlass"); // nothing of the PR body
    evaluations.complete(runner, job!.id, { ok: true, model: "m", output: verdict("pass") });

    const decision = await judging;
    expect(decision).toMatchObject({ outcome: "merge", evaluators: [{ status: "pass", model: "m" }] });
    expect(github.comments.get(1)?.body).toContain("fully_flag_gated");
  });

  it("escalates a live PR when no runner is connected", async () => {
    const decision = await service.judge(repo, 1);
    expect(decision).toMatchObject({
      outcome: "escalate",
      evaluators: [{ status: "not_run", reason: "no evaluator runner is connected" }],
    });
  });

  it("replays without asking anything, then asks on request and shows the verdicts", async () => {
    await service.importPulls(repo, 10);
    await evaluations.claim(runner, ["m"], 0);

    const before = await service.simulate(repo, null);
    expect(before.evaluators).toEqual({ online: true, models: ["m"], queued: 0 });
    expect(before.pulls.map((p) => p.draft.evaluators[0]?.status)).toEqual(["not_run", "not_run"]);
    expect(await evaluations.claim(runner, ["m"], 0)).toBeNull();

    expect(await service.evaluateStored(repo, null)).toEqual({ queued: 2 });
    expect(await service.evaluateStored(repo, null)).toEqual({ queued: 0 });
    const waiting = await service.simulate(repo, null);
    expect(waiting.evaluators.queued).toBe(2);
    expect(waiting.pulls[0]!.draft.evaluators[0]).toMatchObject({
      status: "not_run",
      reason: "waiting for the runner",
    });

    expect(await answerAll("fail")).toBe(2);
    const after = await service.simulate(repo, null);
    expect(after.pulls.map((p) => [p.draft.outcome, p.draft.evaluators[0]?.status])).toEqual([
      ["escalate", "fail"],
      ["escalate", "fail"],
    ]);

    // A reworded question is a different question: its verdicts are not reused.
    const draft = FLAGGED_POLICY.replace(
      "        min_confidence",
      "        question: Is it all behind {{flag}}?\n        min_confidence",
    );
    const reworded = await service.simulate(repo, draft);
    expect(reworded.pulls.map((p) => p.draft.evaluators[0]?.status)).toEqual(["not_run", "not_run"]);
    expect(reworded.pulls.map((p) => p.current.evaluators[0]?.status)).toEqual(["fail", "fail"]);
  });

  it("won't queue anything for an invalid draft or without a runner", async () => {
    await service.importPulls(repo, 10);
    await expect(service.evaluateStored(repo, null)).rejects.toThrow("no evaluator runner is connected");
    await evaluations.claim(runner, ["m"], 0);
    await expect(service.evaluateStored(repo, "policy: v2")).rejects.toThrow("invalid");
  });
});
