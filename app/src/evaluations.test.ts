import { describe, expect, it } from "vitest";
import { EvaluatorNotRun, type EvaluatorRequest } from "../../src/index.js";
import { Evaluations, hashRunnerToken } from "./evaluations.js";
import { Store } from "./store.js";

const PASS = { verdict: "pass", confidence: 0.9, evidence: [] };

function request(overrides: Partial<EvaluatorRequest> = {}): EvaluatorRequest {
  return {
    evaluator: "fully_flag_gated",
    question: "Is it behind the flag?",
    headSha: "head",
    diff: "DIFF",
    intent: { category: "flagged_feature", flag: "f" },
    facts: { files: [], stats: { files: 0, additions: 0, deletions: 0 } },
    ...overrides,
  };
}

function setup(options: { installationId?: number | null } = {}) {
  const store = new Store(":memory:");
  let time = Date.parse("2026-11-15T12:00:00Z");
  const evaluations = new Evaluations({ store, now: () => new Date(time) });
  const runner = store.upsertRunner("r", hashRunnerToken("t".repeat(32)), options.installationId ?? null);
  return { store, evaluations, runner, advance: (ms: number) => (time += ms) };
}
const signal = new AbortController().signal;

describe("Evaluations", () => {
  it("hands a waiting judge's question to a runner and stores the verdict", async () => {
    const { evaluations, runner, store } = setup();
    expect(await evaluations.claim(runner, ["m"], 0)).toBeNull();

    const answer = evaluations.runner("wait", 7).run(request(), signal);
    const job = await evaluations.claim(runner, ["m"], 0);
    expect(job).toMatchObject({ model: null, schema: { type: "object" } });
    expect(job!.user).toContain("Is it behind the flag?");
    expect(JSON.stringify(job)).not.toContain("flagged_feature");
    expect(evaluations.status(7)).toMatchObject({ online: true, models: ["m"], queued: 1 });

    expect(evaluations.complete(runner, job!.id, { ok: true, model: "claude-x", output: PASS })).toBe(true);
    expect(await answer).toEqual({ model: "claude-x", output: PASS });
    expect(store.countVerdicts()).toBe(1);
    expect(evaluations.status(7).queued).toBe(0);

    // The same question about the same diff is never asked again, whatever the mode.
    expect(await evaluations.runner("cached", 7).run(request({ evaluator: "renamed" }), signal)).toEqual({
      model: "claude-x",
      output: PASS,
    });
    expect(await evaluations.claim(runner, ["m"], 0)).toBeNull();
  });

  it("asks again when the question, the diff or the model changes", async () => {
    const { evaluations } = setup();
    const keys = [
      request(),
      request({ question: "Another?" }),
      request({ diff: "OTHER" }),
      request({ model: "claude-haiku-5-5" }),
    ].map((r) => evaluations.key(r));
    expect(new Set(keys).size).toBe(4);
    expect(evaluations.key(request({ headSha: "moved", evaluator: "x" }))).toBe(keys[0]);
  });

  it("wakes a runner that is already waiting", async () => {
    const { evaluations, runner } = setup();
    const claimed = evaluations.claim(runner, ["m"], 5_000);
    const answer = evaluations.runner("wait", null).run(request(), signal);
    const job = await claimed;
    evaluations.complete(runner, job!.id, { ok: true, model: "m", output: PASS });
    await expect(answer).resolves.toMatchObject({ model: "m" });
  });

  it("replays from stored verdicts only, and says why there is none", async () => {
    const { evaluations, runner } = setup();
    const cached = () => evaluations.runner("cached", null).run(request(), signal);
    await expect(cached()).rejects.toBeInstanceOf(EvaluatorNotRun);
    expect(await evaluations.claim(runner, ["m"], 0)).toBeNull();

    await expect(evaluations.runner("enqueue", null).run(request(), signal)).rejects.toThrow("waiting for the runner");
    await expect(cached()).rejects.toThrow("waiting for the runner");

    const job = await evaluations.claim(runner, ["m"], 0);
    evaluations.complete(runner, job!.id, { ok: false, kind: "unavailable", message: "You've hit your weekly limit" });
    const failure = cached();
    await expect(failure).rejects.toThrow("the runner could not ask the model: You've hit your weekly limit");
    await expect(failure).rejects.not.toBeInstanceOf(EvaluatorNotRun);
  });

  it("doesn't keep a malformed answer", async () => {
    const { evaluations, runner, store } = setup();
    await evaluations.claim(runner, ["m"], 0);
    const answer = evaluations.runner("wait", null).run(request(), signal);
    const job = await evaluations.claim(runner, ["m"], 0);
    evaluations.complete(runner, job!.id, { ok: true, model: "m", output: { verdict: "maybe" } });
    await expect(answer).rejects.toThrow("malformed");
    expect(store.countVerdicts()).toBe(0);
  });

  it("fails fast when no runner is connected, and gives up on one that goes quiet", async () => {
    const { evaluations, runner, advance } = setup();
    await expect(evaluations.runner("wait", null).run(request(), signal)).rejects.toThrow(
      "no evaluator runner is connected",
    );

    await evaluations.claim(runner, ["m"], 0);
    const answer = evaluations.runner("wait", null).run(request(), signal);
    const job = await evaluations.claim(runner, ["m"], 0);
    advance(5 * 60_000);
    expect(evaluations.status(null).online).toBe(true); // busy with the job, so still there
    advance(11 * 60_000);
    expect(evaluations.status(null)).toMatchObject({ online: false, queued: 0 });
    await expect(answer).rejects.toThrow("the runner did not answer");
    expect(evaluations.complete(runner, job!.id, { ok: true, model: "m", output: PASS })).toBe(false);
  });

  it("keeps a runner to its own installation", async () => {
    const { evaluations, runner, store } = setup({ installationId: 1 });
    const other = store.upsertRunner("other", hashRunnerToken("o".repeat(32)), 2);
    await evaluations.claim(runner, ["m"], 0);
    expect(evaluations.status(1).online).toBe(true);
    expect(evaluations.status(2).online).toBe(false);

    await evaluations.claim(other, ["m"], 0);
    void evaluations
      .runner("enqueue", 2)
      .run(request(), signal)
      .catch(() => {});
    expect(await evaluations.claim(runner, ["m"], 0)).toBeNull();
    const job = await evaluations.claim(other, ["m"], 0);
    expect(job).not.toBeNull();
    expect(evaluations.complete(runner, job!.id, { ok: true, model: "m", output: PASS })).toBe(false);
  });
});
