import type { RunnerConfig } from "./config.js";
import type { EvaluationJob, JobResult } from "./evaluations.js";

/**
 * Something that can put one question to a model: a subscription CLI, an API
 * key, another vendor. It gets the prompt and the schema, and nothing else.
 */
export interface ModelBackend {
  name: string;
  /**
   * Asks the model. `model` is one of the runner's configured models. Resolves
   * with the answer or the reason there is none; never rejects for a model-side failure.
   */
  ask(job: EvaluationJob & { model: string }, signal: AbortSignal): Promise<JobResult>;
}

export interface RunnerDeps {
  config: RunnerConfig;
  backend: ModelBackend;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  /** Seconds to wait before asking again after the App couldn't be reached. */
  retrySeconds?: number;
  /** How long one question may take. */
  askTimeoutMs?: number;
}

/**
 * The evaluator runner's loop: ask the App for a job, put it to the model,
 * post the answer, one job at a time. It only makes outbound requests, so it
 * runs the same next to the App or on someone's own machine.
 */
export async function runRunner(deps: RunnerDeps, stop: AbortSignal): Promise<void> {
  const { config, backend } = deps;
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  let unreachable = false;

  while (!stop.aborted) {
    let job: EvaluationJob | null;
    try {
      job = await claim(doFetch, config, headers, stop);
      if (unreachable) log(`reached ${config.appUrl} again`);
      unreachable = false;
    } catch (error) {
      if (stop.aborted) return;
      if (!unreachable) log(`could not ask ${config.appUrl} for work: ${message(error)}`);
      unreachable = true;
      await sleep((deps.retrySeconds ?? 10) * 1000, stop);
      continue;
    }
    if (!job) continue;

    const result = await answer(job, config, backend, deps.askTimeoutMs ?? 10 * 60_000, stop);
    log(
      result.ok
        ? `answered ${job.id} with ${result.model} in ${result.durationMs ?? "?"} ms`
        : `no answer to ${job.id} (${result.kind}): ${result.message}`,
    );
    try {
      const response = await doFetch(`${config.appUrl}/runner/v1/jobs/${encodeURIComponent(job.id)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(result),
      });
      if (!response.ok) log(`the App refused the answer to ${job.id}: ${response.status}`);
    } catch (error) {
      log(`could not post the answer to ${job.id}: ${message(error)}`);
    }
  }
}

async function claim(
  doFetch: typeof fetch,
  config: RunnerConfig,
  headers: Record<string, string>,
  stop: AbortSignal,
): Promise<EvaluationJob | null> {
  const response = await doFetch(`${config.appUrl}/runner/v1/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ models: config.models, wait: 25 }),
    signal: AbortSignal.any([stop, AbortSignal.timeout(60_000)]),
  });
  if (response.status === 204) return null;
  if (response.status === 401) throw new Error("the App does not know this runner token");
  if (!response.ok) throw new Error(`the App answered ${response.status}`);
  return ((await response.json()) as { job: EvaluationJob }).job;
}

async function answer(
  job: EvaluationJob,
  config: RunnerConfig,
  backend: ModelBackend,
  timeoutMs: number,
  stop: AbortSignal,
): Promise<JobResult> {
  const model = job.model ?? config.models[0]!;
  // The policy names the model, and a policy is only ever read from the base branch; even so, a runner
  // spends its owner's allowance, so it runs the models its owner listed and no others.
  if (!config.models.includes(model)) {
    return { ok: false, kind: "error", message: `this runner does not offer the model \`${model}\`` };
  }
  const started = Date.now();
  try {
    const result = await backend.ask({ ...job, model }, AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]));
    return result.ok ? { ...result, durationMs: Date.now() - started } : result;
  } catch (error) {
    return { ok: false, kind: "error", message: message(error) };
  }
}

function sleep(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      stop.removeEventListener("abort", done);
      resolve();
    }
    stop.addEventListener("abort", done, { once: true });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
