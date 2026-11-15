import { createHash } from "node:crypto";
import { z } from "zod";
import {
  decide,
  defaultGateRegistry,
  evaluatorPresets,
  NOT_RUN_NO_RUNNER,
  parsePolicy,
  policyToGraph,
  QUESTION_PLACEHOLDERS,
  type DecisionRecord,
  type EvaluatorPreset,
  type FlowGraph,
  type GateRegistry,
  type PolicyError,
  type PolicyResult,
} from "../../src/index.js";
import { evaluatePullRequest, snapshotPullRequest, type Snapshot } from "../../github/run.js";
import type { Evaluations, EvaluatorStatus } from "./evaluations.js";
import { checkFor, type AppGitHubPort } from "./port.js";
import type { PullState, Repo, Store, StoredPull } from "./store.js";

/** Reaches GitHub for a repo. `write` is false in dev mode, where Windlass only ever reads. */
export interface GitHubAccess {
  forRepo(repo: Repo): Promise<{ port: AppGitHubPort; write: boolean } | null>;
}

export interface ServiceOptions {
  store: Store;
  github: GitHubAccess;
  policyPath: string;
  /** Public origin of the editor, for links from check runs. */
  baseUrl?: string;
  gates?: GateRegistry;
  /** Where evaluator questions go. Without it evaluators have no runner, and their lanes escalate. */
  evaluations?: Evaluations;
  /** How long judging a live PR waits for a runner's answer. */
  evaluatorTimeoutMs?: number;
  now?: () => Date;
}

/** What the editor needs to offer evaluators. */
export interface EvaluatorCatalog {
  presets: readonly EvaluatorPreset[];
  /** Names a question can use as `{{name}}`. */
  placeholders: readonly string[];
}

/** A gate the editor can add, with the shape of its arguments. */
export interface GateInfo {
  name: string;
  description: string;
  defaultOnFail: "escalate" | "block";
  /** JSON Schema of the gate's arguments. */
  args: unknown;
}

export interface SimulatedPull {
  number: number;
  title: string;
  author: string;
  state: PullState;
  headSha: string;
  /** Decided under the policy on the default branch. */
  current: DecisionRecord;
  /** Decided under the draft; equal to `current` when no draft was given. */
  draft: DecisionRecord;
}

export interface Simulation {
  policy: { ok: boolean; hash: string; errors: PolicyError[] };
  /** The draft as a flowchart; null when it is too broken to draw. */
  graph: FlowGraph | null;
  /** Policy errors that belong to no node of the graph. */
  unplaced: PolicyError[];
  pulls: SimulatedPull[];
  /** Whether a runner is there to answer evaluators, and how much it has waiting. */
  evaluators: EvaluatorStatus;
}

/** A runner works through its jobs one at a time, so a live PR may wait behind a replay. */
const DEFAULT_EVALUATOR_TIMEOUT_MS = 15 * 60_000;

export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

/** What the App does, apart from HTTP: judging PRs as they change, and replaying them under a draft policy. */
export class Service {
  private readonly store: Store;
  private readonly github: GitHubAccess;
  private readonly gates: GateRegistry;
  private readonly now: () => Date;

  constructor(private readonly options: ServiceOptions) {
    this.store = options.store;
    this.github = options.github;
    this.gates = options.gates ?? defaultGateRegistry();
    this.now = options.now ?? (() => new Date());
  }

  private get config() {
    return { policyPath: this.options.policyPath };
  }

  private get evaluations(): Evaluations | undefined {
    return this.options.evaluations;
  }

  evaluatorCatalog(): EvaluatorCatalog {
    return { presets: evaluatorPresets, placeholders: QUESTION_PLACEHOLDERS };
  }

  catalog(): GateInfo[] {
    return this.gates.names().map((name) => {
      const gate = this.gates.get(name)!;
      return {
        name,
        description: gate.description,
        defaultOnFail: gate.defaultOnFail,
        args: z.toJSONSchema(gate.args, { unrepresentable: "any", io: "input" }),
      };
    });
  }

  /**
   * Judges a PR after a webhook and reports it on GitHub: the comment and label
   * (as the Action does) and a check run. Shadow mode only: it never merges.
   */
  async judge(repo: Repo, number: number): Promise<DecisionRecord | null> {
    const access = await this.github.forRepo(repo);
    if (!access?.write) throw new ServiceError(409, `Windlass can't report on ${repo.owner}/${repo.name}`);

    const result = await evaluatePullRequest(access.port, number, {
      ...this.config,
      ...(this.evaluations && { evaluators: this.evaluations.runner("wait", repo.installationId) }),
      evaluatorTimeoutMs: this.options.evaluatorTimeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS,
    });
    if (result.status === "skipped") return null;

    const { snapshot, decision } = result;
    this.remember(repo, snapshot, decision);
    this.store.logDecision(repo.id, number, decision);
    await access.port.reportCheck(snapshot.pr.headSha, checkFor(decision, this.pullUrl(repo, number)));
    return decision;
  }

  /** Brings a repo's recent PRs and current policy into the store so they can be replayed. Reads only. */
  async importPulls(repo: Repo, limit: number): Promise<number> {
    const access = await this.github.forRepo(repo);
    if (!access) throw new ServiceError(409, `Windlass has no access to ${repo.owner}/${repo.name}`);

    await this.refreshPolicy(repo, access.port);
    const numbers = await access.port.listRecentPullRequests(limit);
    const known = new Map(this.store.listPulls(repo.id).map((pull) => [pull.number, pull]));
    for (const number of numbers) {
      const snapshot = await snapshotPullRequest(access.port, number, this.config);
      const previous = known.get(number);
      // A decision already reported for this head is still the decision; a new head has none yet.
      this.remember(repo, snapshot, previous?.headSha === snapshot.pr.headSha ? previous.decision : null);
    }
    return numbers.length;
  }

  /** Open PRs whose head is `sha`: the ones a CI result for that commit is about. */
  async pullsAtHead(repo: Repo, sha: string): Promise<number[]> {
    const access = await this.github.forRepo(repo);
    return access ? access.port.findOpenPullRequests(sha) : [];
  }

  /** Re-reads the policy on the default branch. */
  async refreshPolicy(repo: Repo, port?: AppGitHubPort): Promise<string | null> {
    const client = port ?? (await this.github.forRepo(repo))?.port;
    if (!client) return repo.policySource;
    const source = await client.getFile(this.options.policyPath, await client.getDefaultBranch());
    this.store.setPolicySource(repo.id, source);
    return source;
  }

  /**
   * Decides every stored PR of a repo twice: under the policy on the default
   * branch and under `draft`. Nothing is written, here or on GitHub, and no
   * model is asked anything: evaluators answer from stored verdicts or show as not run.
   */
  async simulate(repo: Repo, draft: string | null): Promise<Simulation> {
    const currentPolicy = this.parse(repo.policySource, repo);
    const draftPolicy = draft === null ? currentPolicy : parsePolicy(draft, this.gates);
    const options = {
      gates: this.gates,
      now: this.now,
      ...(this.evaluations && { evaluators: this.evaluations.runner("cached", repo.installationId) }),
    };

    const pulls: SimulatedPull[] = [];
    for (const pull of this.store.listPulls(repo.id)) {
      const current = await decide(pull.input, { ...options, policy: currentPolicy });
      pulls.push({
        number: pull.number,
        title: pull.title,
        author: pull.author,
        state: pull.state,
        headSha: pull.headSha,
        current,
        draft: draftPolicy === currentPolicy ? current : await decide(pull.input, { ...options, policy: draftPolicy }),
      });
    }

    const drawable = draftPolicy.ok ? draftPolicy.policy : draftPolicy.partial;
    const errors = draftPolicy.ok ? [] : draftPolicy.errors;
    const drawn = drawable ? policyToGraph(drawable, this.gates, errors) : null;
    return {
      policy: { ok: draftPolicy.ok, hash: draftPolicy.hash, errors },
      graph: drawn?.graph ?? null,
      unplaced: drawn?.unplaced ?? errors,
      pulls,
      evaluators: this.evaluations?.status(repo.installationId) ?? { online: false, models: [], queued: 0 },
    };
  }

  /**
   * Asks a runner every evaluator question the stored PRs reach under `draft`
   * and have no verdict for. Returns at once; the verdicts show on later replays.
   *
   * An evaluator only runs while its PR is still on the merge path, so a lane's
   * second evaluator is asked once its first has passed.
   */
  async evaluateStored(repo: Repo, draft: string | null): Promise<{ queued: number }> {
    if (!this.evaluations) throw new ServiceError(409, "this Windlass has no evaluator runner configured");
    const policy = draft === null ? this.parse(repo.policySource, repo) : parsePolicy(draft, this.gates);
    if (!policy.ok) throw new ServiceError(400, "the policy is invalid; fix its errors before running evaluators");
    if (!this.evaluations.status(repo.installationId).online) {
      throw new ServiceError(409, NOT_RUN_NO_RUNNER);
    }

    const before = this.evaluations.status(repo.installationId).queued;
    const evaluators = this.evaluations.runner("enqueue", repo.installationId);
    for (const pull of this.store.listPulls(repo.id)) {
      await decide(pull.input, { policy, gates: this.gates, now: this.now, evaluators });
    }
    return { queued: this.evaluations.status(repo.installationId).queued - before };
  }

  /**
   * Proposes a policy as a PR against the default branch. The policy is never
   * written to the branch directly: the PR touches `.windlass/`, so Windlass
   * itself escalates it to a human.
   */
  async proposePolicy(repo: Repo, source: string): Promise<string> {
    const parsed = parsePolicy(source, this.gates);
    if (!parsed.ok) throw new ServiceError(400, "the policy is invalid; fix its errors before opening a pull request");
    if (source === repo.policySource) throw new ServiceError(400, "the policy is unchanged");

    const access = await this.github.forRepo(repo);
    if (!access?.write) throw new ServiceError(409, "Windlass can only open pull requests as the GitHub App");

    const simulation = await this.simulate(repo, source);
    const changed = simulation.pulls.filter((pull) => pull.current.outcome !== pull.draft.outcome);
    const body = [
      "Proposed from the Windlass editor.",
      "",
      changed.length === 0
        ? `Replayed over the ${simulation.pulls.length} pull request(s) Windlass has seen: no decision changes.`
        : `Replayed over the ${simulation.pulls.length} pull request(s) Windlass has seen, ${changed.length} decision(s) change:`,
      "",
      ...changed.slice(0, 50).map((pull) => `- #${pull.number}: ${pull.current.outcome} → ${pull.draft.outcome}`),
      ...(changed.length > 50 ? [`- …and ${changed.length - 50} more`] : []),
    ].join("\n");

    try {
      return await access.port.proposeFile({
        path: this.options.policyPath,
        content: source,
        branch: `windlass/policy-${parsed.hash.slice(0, 10)}`,
        title: "Update the Windlass policy",
        body,
      });
    } catch (error) {
      throw new ServiceError(502, `GitHub refused the pull request: ${error instanceof Error ? error.message : error}`);
    }
  }

  private remember(repo: Repo, snapshot: Snapshot, decision: DecisionRecord | null): void {
    const { pr } = snapshot;
    const pull: StoredPull = {
      repoId: repo.id,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      state: pr.merged ? "merged" : pr.state,
      headSha: pr.headSha,
      input: snapshot.input,
      decision,
      updatedAt: this.now().toISOString(),
    };
    this.store.savePull(pull);
  }

  private parse(source: string | null, repo: Repo): PolicyResult {
    if (source !== null) return parsePolicy(source, this.gates);
    return {
      ok: false,
      hash: createHash("sha256").update("").digest("hex"),
      errors: [{ path: "", message: `${repo.owner}/${repo.name} has no policy at ${this.options.policyPath}` }],
    };
  }

  private pullUrl(repo: Repo, number: number): string | undefined {
    if (!this.options.baseUrl) return undefined;
    return `${this.options.baseUrl}/?repo=${encodeURIComponent(`${repo.owner}/${repo.name}`)}&pr=${number}`;
  }
}
