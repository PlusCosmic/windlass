import { z } from "zod";
import type { KeyedQueue } from "./queue.js";
import type { Service } from "./service.js";
import type { Repo, Store } from "./store.js";

export interface WebhookDeps {
  store: Store;
  service: Service;
  queue: KeyedQueue;
  /** The App's own id, so it can ignore the check suite its own check runs create. */
  appId: () => Promise<number>;
  policyPath: string;
}

const RepoRef = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  default_branch: z.string().optional(),
});
const Installation = z.object({ id: z.number() });
const Listed = z.array(z.object({ full_name: z.string() }));

const PullRequestEvent = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number(), merged: z.boolean().optional() }),
  repository: RepoRef,
  installation: Installation,
});
const CheckSuiteEvent = z.object({
  action: z.string(),
  check_suite: z.object({
    head_sha: z.string(),
    app: z.object({ id: z.number() }).nullish(),
    pull_requests: z.array(z.object({ number: z.number() })).default([]),
  }),
  repository: RepoRef,
  installation: Installation,
});
const StatusEvent = z.object({ sha: z.string(), repository: RepoRef, installation: Installation });
const PushEvent = z.object({
  ref: z.string(),
  commits: z
    .array(
      z.object({
        added: z.array(z.string()).default([]),
        modified: z.array(z.string()).default([]),
        removed: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  repository: RepoRef,
  installation: Installation,
});
const InstallationEvent = z.object({
  action: z.string(),
  installation: Installation,
  repositories: Listed.default([]),
});
const InstallationReposEvent = z.object({
  action: z.string(),
  installation: Installation,
  repositories_added: Listed.default([]),
  repositories_removed: Listed.default([]),
});

/** The PR changes that can change a decision. Labels and reviews can't; Windlass's own label would loop. */
const JUDGE_ON = new Set(["opened", "synchronize", "reopened", "edited", "ready_for_review"]);

/**
 * Acts on one verified webhook delivery and says what it did. Judging is
 * queued, so this returns as soon as the work is known; a payload it can't
 * read is an error for the caller to report.
 */
export async function handleWebhook(deps: WebhookDeps, event: string, payload: unknown): Promise<string> {
  const { store, service, queue } = deps;

  const judge = (repo: Repo, numbers: number[]) => {
    for (const number of numbers) {
      queue.run(`${repo.id}#${number}`, async () => {
        // Read again inside the job: the installation may have changed while it waited.
        const current = store.getRepo(repo.owner, repo.name);
        if (current) await service.judge(current, number);
      });
    }
    return numbers.length === 0 ? "no open pull request" : `judging ${numbers.map((n) => `#${n}`).join(", ")}`;
  };
  const repoOf = (ref: z.infer<typeof RepoRef>, installation: { id: number }) =>
    store.upsertRepo(ref.owner.login, ref.name, installation.id);

  switch (event) {
    case "pull_request": {
      const data = PullRequestEvent.parse(payload);
      const repo = repoOf(data.repository, data.installation);
      if (data.action === "closed") {
        store.setPullState(repo.id, data.pull_request.number, data.pull_request.merged ? "merged" : "closed");
        return `#${data.pull_request.number} closed`;
      }
      if (!JUDGE_ON.has(data.action)) return `ignored pull_request.${data.action}`;
      return judge(repo, [data.pull_request.number]);
    }
    case "check_suite": {
      const data = CheckSuiteEvent.parse(payload);
      if (data.action !== "completed") return `ignored check_suite.${data.action}`;
      if (data.check_suite.app?.id === (await deps.appId())) return "ignored Windlass's own check suite";
      const repo = repoOf(data.repository, data.installation);
      const listed = data.check_suite.pull_requests.map((pr) => pr.number);
      return judge(repo, listed.length > 0 ? listed : await service.pullsAtHead(repo, data.check_suite.head_sha));
    }
    case "status": {
      const data = StatusEvent.parse(payload);
      const repo = repoOf(data.repository, data.installation);
      return judge(repo, await service.pullsAtHead(repo, data.sha));
    }
    case "push": {
      const data = PushEvent.parse(payload);
      const repo = repoOf(data.repository, data.installation);
      if (data.ref !== `refs/heads/${data.repository.default_branch}`) return "ignored a push off the default branch";
      const touched = data.commits.some((commit) =>
        [...commit.added, ...commit.modified, ...commit.removed].includes(deps.policyPath),
      );
      if (!touched) return "ignored a push that left the policy alone";
      await service.refreshPolicy(repo);
      return "policy refreshed";
    }
    case "installation": {
      const data = InstallationEvent.parse(payload);
      if (data.action === "deleted" || data.action === "suspend") {
        store.detachInstallation(data.installation.id);
        return "installation detached";
      }
      for (const repo of splitNames(data.repositories)) store.upsertRepo(repo.owner, repo.name, data.installation.id);
      return `installation ${data.action}: ${data.repositories.length} repo(s)`;
    }
    case "installation_repositories": {
      const data = InstallationReposEvent.parse(payload);
      for (const repo of splitNames(data.repositories_added)) {
        store.upsertRepo(repo.owner, repo.name, data.installation.id);
      }
      store.detachInstallation(data.installation.id, splitNames(data.repositories_removed));
      return `+${data.repositories_added.length} -${data.repositories_removed.length} repo(s)`;
    }
    default:
      return `ignored ${event}`;
  }
}

function splitNames(repos: { full_name: string }[]): { owner: string; name: string }[] {
  return repos.flatMap((repo) => {
    const [owner, name, ...rest] = repo.full_name.split("/");
    return owner && name && rest.length === 0 ? [{ owner, name }] : [];
  });
}
