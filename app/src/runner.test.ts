import { describe, expect, it } from "vitest";
import { claudeBackend, type QueryFn, type SdkMessage } from "./claude-backend.js";
import { loadRunnerConfig } from "./config.js";
import type { EvaluationJob, JobResult } from "./evaluations.js";
import { runRunner, type ModelBackend } from "./runner.js";

const TOKEN = "r".repeat(40);
const JOB: EvaluationJob = { id: "j1", model: null, system: "SYSTEM", user: "USER", schema: { type: "object" } };
const PASS = { verdict: "pass", confidence: 0.9, evidence: [] };

function sdk(messages: SdkMessage[], seen?: (input: Parameters<QueryFn>[0]) => void): QueryFn {
  return (input) => {
    seen?.(input);
    return (async function* () {
      yield* messages;
    })();
  };
}
const init = (tools: string[]): SdkMessage => ({ type: "system", subtype: "init", tools, model: "claude-opus-5-5" });
const ask = (query: QueryFn, env: NodeJS.ProcessEnv = {}) =>
  claudeBackend({ query, env }).ask({ ...JOB, model: "claude-opus-5-5" }, new AbortController().signal);

describe("claudeBackend", () => {
  it("asks with every tool off and only its own credential in the environment", async () => {
    let input: Parameters<QueryFn>[0] | undefined;
    const result = await ask(
      sdk(
        [
          init(["StructuredOutput"]),
          { type: "result", subtype: "success", structured_output: PASS, modelUsage: { "claude-opus-5-5": {} } },
        ],
        (i) => (input = i),
      ),
      { PATH: "/bin", HOME: "/home/node", CLAUDE_CODE_OAUTH_TOKEN: "sub", GITHUB_APP_PRIVATE_KEY: "pem", OTHER: "x" },
    );
    expect(result).toEqual({ ok: true, model: "claude-opus-5-5", output: PASS });
    expect(input?.prompt).toBe("USER");
    expect(input?.options).toMatchObject({
      model: "claude-opus-5-5",
      systemPrompt: "SYSTEM",
      tools: [],
      skills: [],
      settingSources: [],
      persistSession: false,
      outputFormat: { type: "json_schema", schema: { type: "object" } },
      env: { PATH: "/bin", HOME: "/home/node", CLAUDE_CODE_OAUTH_TOKEN: "sub" },
    });
    const env = input?.options.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"]);
  });

  it("abandons the question if the CLI offers the model any other tool", async () => {
    const result = await ask(
      sdk([init(["StructuredOutput", "Bash"]), { type: "result", subtype: "success", structured_output: PASS }]),
    );
    expect(result).toEqual({ ok: false, kind: "error", message: "the CLI offered tools it must not have: Bash" });
  });

  it("tells a spent allowance or a sign-out from a failure", async () => {
    const failed = (result: string) =>
      ask(sdk([init(["StructuredOutput"]), { type: "result", subtype: "success", is_error: true, result }]));
    expect(await failed("You've hit your weekly limit")).toMatchObject({ ok: false, kind: "unavailable" });
    expect(await failed("Not logged in · Please run /login")).toMatchObject({ ok: false, kind: "unavailable" });
    expect(await failed("Something else broke")).toMatchObject({ ok: false, kind: "error" });
    expect(
      await ask(sdk([init(["StructuredOutput"]), { type: "result", subtype: "error_max_structured_output_retries" }])),
    ).toMatchObject({ ok: false, kind: "error", message: "error_max_structured_output_retries" });
    expect(
      await ask(sdk([init(["StructuredOutput"]), { type: "result", subtype: "success", result: "prose" }])),
    ).toEqual({ ok: false, kind: "error", message: "the model gave no structured answer" });
  });
});

describe("runRunner", () => {
  function app(jobs: (EvaluationJob | null)[]) {
    const posted: { path: string; body: JobResult }[] = [];
    const stop = new AbortController();
    const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      if (path === "/runner/v1/claim") {
        const job = jobs.shift();
        if (job === undefined) {
          stop.abort();
          return new Response(null, { status: 204 });
        }
        return job ? Response.json({ job }) : new Response(null, { status: 204 });
      }
      posted.push({ path, body: JSON.parse(String(init?.body)) as JobResult });
      return Response.json({ ok: true });
    }) as typeof fetch;
    return { posted, stop, doFetch };
  }
  const config = { appUrl: "http://windlass:8080", token: TOKEN, models: ["claude-opus-5-5", "claude-haiku-5-5"] };

  it("takes jobs one at a time, asks the model and posts each answer", async () => {
    const asked: string[] = [];
    const backend: ModelBackend = {
      name: "fake",
      async ask(job) {
        asked.push(`${job.id}:${job.model}`);
        return { ok: true, model: job.model, output: PASS };
      },
    };
    const { posted, stop, doFetch } = app([JOB, null, { ...JOB, id: "j2", model: "claude-haiku-5-5" }]);
    await runRunner({ config, backend, fetch: doFetch }, stop.signal);

    expect(asked).toEqual(["j1:claude-opus-5-5", "j2:claude-haiku-5-5"]);
    expect(posted.map((p) => p.path)).toEqual(["/runner/v1/jobs/j1", "/runner/v1/jobs/j2"]);
    expect(posted[0]!.body).toMatchObject({ ok: true, model: "claude-opus-5-5", output: PASS });
  });

  it("refuses a model its owner didn't list, and reports a backend that throws", async () => {
    const backend: ModelBackend = {
      name: "fake",
      async ask() {
        throw new Error("spawn failed");
      },
    };
    const { posted, stop, doFetch } = app([{ ...JOB, model: "claude-fable-5-2" }, JOB]);
    await runRunner({ config, backend, fetch: doFetch }, stop.signal);
    expect(posted.map((p) => p.body)).toEqual([
      { ok: false, kind: "error", message: "this runner does not offer the model `claude-fable-5-2`" },
      { ok: false, kind: "error", message: "spawn failed" },
    ]);
  });
});

describe("loadRunnerConfig", () => {
  const env = { WINDLASS_RUNNER_TOKEN: TOKEN, WINDLASS_APP_URL: "http://windlass:8080/" };

  it("reads where the App is and which models to offer", () => {
    expect(loadRunnerConfig(env)).toEqual({
      appUrl: "http://windlass:8080",
      token: TOKEN,
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    });
    expect(loadRunnerConfig({ ...env, WINDLASS_RUNNER_MODELS: "claude-haiku-5-5, " }).models).toEqual([
      "claude-haiku-5-5",
    ]);
  });

  it("refuses to start holding the App's secrets, or without its own", () => {
    expect(() => loadRunnerConfig({ ...env, GITHUB_APP_PRIVATE_KEY: "pem" })).toThrow("must not be given");
    expect(() => loadRunnerConfig({ WINDLASS_APP_URL: "http://x" })).toThrow("WINDLASS_RUNNER_TOKEN");
    expect(() => loadRunnerConfig({ ...env, WINDLASS_RUNNER_TOKEN: "short" })).toThrow("at least 32");
  });
});
