import { createHash } from "node:crypto";
import {
  buildEvaluatorPrompt,
  EvaluatorNotRun,
  NOT_RUN_NO_RUNNER,
  NOT_RUN_WAITING,
  PROMPT_VERSION,
  VERDICT_JSON_SCHEMA,
  VerdictSchema,
  type EvaluatorRequest,
  type EvaluatorResponse,
  type EvaluatorRunner,
} from "../../src/index.js";
import type { Runner, Store } from "./store.js";

/** One question for a runner: everything it needs, and nothing that identifies a repo or a person. */
export interface EvaluationJob {
  id: string;
  /** The model the policy asks for; null leaves it to the runner's default. */
  model: string | null;
  system: string;
  user: string;
  /** JSON Schema the answer must match. */
  schema: unknown;
}

export type JobResult =
  | { ok: true; model: string; output: unknown; durationMs?: number | undefined }
  /** `unavailable`: the runner couldn't ask (usage limit, signed out). `error`: it asked and got nothing usable. */
  | { ok: false; kind: "unavailable" | "error"; message: string };

/**
 * How a decision gets its verdicts:
 * - `wait`: ask a runner and wait for the answer (judging a live PR).
 * - `cached`: only what is already stored (replaying under a draft, which must not spend anything).
 * - `enqueue`: ask a runner but don't wait (the editor's "run" button); the verdict shows on a later replay.
 */
export type EvaluationMode = "wait" | "cached" | "enqueue";

export interface EvaluatorStatus {
  /** A runner that can take this installation's jobs asked for work recently. */
  online: boolean;
  /** Models the online runners offer; the first is the default. */
  models: string[];
  /** Jobs waiting for or with a runner. */
  queued: number;
}

interface Pending {
  job: EvaluationJob;
  key: string;
  evaluator: string;
  installationId: number | null;
  runnerId: number | null;
  claimedAt: number | null;
  promise: Promise<EvaluatorResponse>;
  resolve: (response: EvaluatorResponse) => void;
  reject: (error: Error) => void;
}

interface Waiter {
  runner: Runner;
  deliver: (job: EvaluationJob | null) => void;
}

export interface EvaluationsOptions {
  store: Store;
  now?: () => Date;
  /** How long after it last asked for work a runner still counts as connected. */
  onlineWindowMs?: number;
  /** How long a runner may hold a job before it is given up on. */
  leaseMs?: number;
}

/**
 * Hands evaluator questions to runners and keeps their verdicts.
 *
 * Windlass never calls a model. A runner (a separate process with a model
 * credential of its own) pulls jobs from here and posts answers back, so the
 * App holds no model credential and a runner holds no GitHub one. Jobs live in
 * memory: whoever waits on one is in this process too.
 */
export class Evaluations {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly onlineWindowMs: number;
  private readonly leaseMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly byKey = new Map<string, Pending>();
  /** Why the last attempt at a key produced no verdict; cleared when it is asked again. */
  private readonly failures = new Map<string, string>();
  private waiters: Waiter[] = [];
  private sequence = 0;

  constructor(options: EvaluationsOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.onlineWindowMs = options.onlineWindowMs ?? 90_000;
    this.leaseMs = options.leaseMs ?? 15 * 60_000;
  }

  /** A verdict is reused only for the same question about the same diff from the same model. */
  key(request: EvaluatorRequest): string {
    const diff = createHash("sha256").update(request.diff).digest("hex");
    return createHash("sha256")
      .update(JSON.stringify([PROMPT_VERSION, request.model ?? null, request.question, diff]))
      .digest("hex");
  }

  runner(mode: EvaluationMode, installationId: number | null): EvaluatorRunner {
    return {
      run: async (request) => {
        const key = this.key(request);
        const stored = this.store.getVerdict(key);
        if (stored) return stored;

        const inFlight = this.byKey.get(key);
        if (mode === "cached") {
          if (inFlight) throw new EvaluatorNotRun(NOT_RUN_WAITING);
          const failure = this.failures.get(key);
          if (failure !== undefined) throw new Error(failure);
          throw new EvaluatorNotRun();
        }
        if (!inFlight && !this.status(installationId).online) {
          throw new EvaluatorNotRun(NOT_RUN_NO_RUNNER);
        }
        const pending = inFlight ?? this.enqueue(key, request, installationId);
        if (mode === "enqueue") throw new EvaluatorNotRun(NOT_RUN_WAITING);
        return pending.promise;
      },
    };
  }

  /** Stores a verdict that didn't come from a runner (dev fixtures). */
  seed(request: EvaluatorRequest, response: EvaluatorResponse): void {
    this.store.saveVerdict(this.key(request), {
      evaluator: request.evaluator,
      model: response.model,
      output: response.output,
      createdAt: this.now().toISOString(),
    });
  }

  status(installationId: number | null): EvaluatorStatus {
    this.expire();
    const cutoff = this.now().getTime() - this.onlineWindowMs;
    const busy = new Set([...this.pending.values()].map((p) => p.runnerId));
    const online = this.store
      .listRunners()
      .filter((runner) => serves(runner, installationId))
      // A runner working on a job isn't asking for another, and is still there.
      .filter(
        (runner) => busy.has(runner.id) || (runner.lastSeenAt !== null && Date.parse(runner.lastSeenAt) >= cutoff),
      );
    return {
      online: online.length > 0,
      models: [...new Set(online.flatMap((runner) => runner.models))],
      queued: [...this.pending.values()].filter((p) => p.installationId === installationId).length,
    };
  }

  /**
   * Gives a runner the next job it may take, waiting up to `waitMs` for one to
   * arrive. Null when there was none.
   */
  claim(runner: Runner, models: string[], waitMs: number): Promise<EvaluationJob | null> {
    this.store.touchRunner(runner.id, models, this.now().toISOString());
    this.expire();
    const next = [...this.pending.values()].find((p) => p.runnerId === null && serves(runner, p.installationId));
    if (next) return Promise.resolve(this.assign(next, runner));
    if (waitMs <= 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter: Waiter = {
        runner,
        deliver: (job) => {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(job);
        },
      };
      const timer = setTimeout(() => waiter.deliver(null), waitMs);
      this.waiters.push(waiter);
    });
  }

  /** Takes a runner's answer to a job it claimed. False when the job isn't its to answer. */
  complete(runner: Runner, jobId: string, result: JobResult): boolean {
    const pending = this.pending.get(jobId);
    if (!pending || pending.runnerId !== runner.id) return false;
    this.forget(pending);

    if (!result.ok) {
      const prefix = result.kind === "unavailable" ? "the runner could not ask the model" : "the runner failed";
      this.fail(pending, `${prefix}: ${result.message.slice(0, 300)}`);
      return true;
    }
    // A malformed answer isn't kept: stored, it would be the verdict for this question forever.
    if (!VerdictSchema.safeParse(result.output).success) {
      this.fail(pending, "evaluator returned malformed output");
      return true;
    }
    this.store.saveVerdict(pending.key, {
      evaluator: pending.evaluator,
      model: result.model,
      output: result.output,
      durationMs: result.durationMs,
      createdAt: this.now().toISOString(),
    });
    pending.resolve({ model: result.model, output: result.output });
    return true;
  }

  private enqueue(key: string, request: EvaluatorRequest, installationId: number | null): Pending {
    this.failures.delete(key);
    const { system, user } = buildEvaluatorPrompt(request);
    const id = `${this.now().getTime().toString(36)}-${(this.sequence++).toString(36)}`;
    let resolve!: Pending["resolve"];
    let reject!: Pending["reject"];
    const promise = new Promise<EvaluatorResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Nobody waits on a job the editor queued; its failure is kept in `failures` instead.
    promise.catch(() => {});

    const pending: Pending = {
      job: { id, model: request.model ?? null, system, user, schema: VERDICT_JSON_SCHEMA },
      key,
      evaluator: request.evaluator,
      installationId,
      runnerId: null,
      claimedAt: null,
      promise,
      resolve,
      reject,
    };
    this.pending.set(id, pending);
    this.byKey.set(key, pending);

    const waiter = this.waiters.find((w) => serves(w.runner, installationId));
    if (waiter) waiter.deliver(this.assign(pending, waiter.runner));
    return pending;
  }

  private assign(pending: Pending, runner: Runner): EvaluationJob {
    pending.runnerId = runner.id;
    pending.claimedAt = this.now().getTime();
    return pending.job;
  }

  private fail(pending: Pending, message: string): void {
    this.failures.set(pending.key, message);
    pending.reject(new Error(message));
  }

  private forget(pending: Pending): void {
    this.pending.delete(pending.job.id);
    if (this.byKey.get(pending.key) === pending) this.byKey.delete(pending.key);
  }

  /** Gives up on jobs a runner took and never answered. */
  private expire(): void {
    const cutoff = this.now().getTime() - this.leaseMs;
    for (const pending of [...this.pending.values()]) {
      if (pending.claimedAt !== null && pending.claimedAt < cutoff) {
        this.forget(pending);
        this.fail(pending, "the runner did not answer");
      }
    }
  }
}

function serves(runner: Runner, installationId: number | null): boolean {
  return runner.installationId === null || runner.installationId === installationId;
}

export function hashRunnerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
