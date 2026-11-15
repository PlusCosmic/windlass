import { beforeEach, describe, expect, it } from "vitest";
import { KeyedQueue } from "./queue.js";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { accessTo, FakeGitHub, POLICY, pull } from "./testing.js";
import { handleWebhook, type WebhookDeps } from "./webhooks.js";

const repository = { name: "app", owner: { login: "acme" }, default_branch: "main" };
const installation = { id: 5 };

let store: Store;
let github: FakeGitHub;
let deps: WebhookDeps;
let errors: unknown[];

beforeEach(() => {
  store = new Store(":memory:");
  github = new FakeGitHub().add(pull(1));
  errors = [];
  const queue = new KeyedQueue((_, error) => errors.push(error));
  const service = new Service({ store, github: accessTo(github), policyPath: ".windlass/policy.yaml" });
  deps = { store, service, queue, appId: async () => 42, policyPath: ".windlass/policy.yaml" };
});

async function deliver(event: string, payload: object): Promise<string> {
  const result = await handleWebhook(deps, event, payload);
  await deps.queue.idle();
  expect(errors).toEqual([]);
  return result;
}

describe("handleWebhook", () => {
  it("judges a PR when it opens, and learns the repo from the event", async () => {
    const result = await deliver("pull_request", {
      action: "opened",
      pull_request: { number: 1 },
      repository,
      installation,
    });
    expect(result).toBe("judging #1");
    expect(store.getRepo("acme", "app")).toMatchObject({ installationId: 5 });
    expect(github.labels.get(1)).toEqual(["windlass/would-merge"]);
  });

  it("ignores the PR events its own labels cause", async () => {
    const payload = { action: "labeled", pull_request: { number: 1 }, repository, installation };
    expect(await deliver("pull_request", payload)).toBe("ignored pull_request.labeled");
    expect(github.reports).toEqual([]);
  });

  it("records a merge", async () => {
    await deliver("pull_request", { action: "opened", pull_request: { number: 1 }, repository, installation });
    await deliver("pull_request", {
      action: "closed",
      pull_request: { number: 1, merged: true },
      repository,
      installation,
    });
    expect(store.listPulls(store.getRepo("acme", "app")!.id)[0]?.state).toBe("merged");
  });

  it("judges again when CI finishes, finding the PR by its head when the event names none", async () => {
    const check_suite = { head_sha: pull(1).headSha, app: { id: 7 }, pull_requests: [] };
    const result = await deliver("check_suite", { action: "completed", check_suite, repository, installation });
    expect(result).toBe("judging #1");
    expect(github.reports).toHaveLength(1);
  });

  it("ignores the check suite its own check run completes, or it would judge forever", async () => {
    const check_suite = { head_sha: pull(1).headSha, app: { id: 42 }, pull_requests: [{ number: 1 }] };
    const result = await deliver("check_suite", { action: "completed", check_suite, repository, installation });
    expect(result).toBe("ignored Windlass's own check suite");
    expect(github.reports).toEqual([]);
  });

  it("judges on a commit status, and does nothing for a commit no open PR is at", async () => {
    expect(await deliver("status", { sha: pull(1).headSha, repository, installation })).toBe("judging #1");
    expect(await deliver("status", { sha: "0".repeat(40), repository, installation })).toBe("no open pull request");
  });

  it("re-reads the policy when the default branch changes it", async () => {
    const push = (ref: string, modified: string[]) =>
      deliver("push", { ref, commits: [{ modified }], repository, installation });
    expect(await push("refs/heads/main", ["README.md"])).toBe("ignored a push that left the policy alone");
    expect(await push("refs/heads/feature", [".windlass/policy.yaml"])).toBe("ignored a push off the default branch");
    expect(store.getRepo("acme", "app")?.policySource).toBeNull();
    expect(await push("refs/heads/main", [".windlass/policy.yaml"])).toBe("policy refreshed");
    expect(store.getRepo("acme", "app")?.policySource).toBe(POLICY);
  });

  it("tracks which repos the App is installed on", async () => {
    await deliver("installation", {
      action: "created",
      installation,
      repositories: [{ full_name: "acme/app" }, { full_name: "acme/site" }],
    });
    expect(store.listRepos().map((r) => [r.name, r.installationId])).toEqual([
      ["app", 5],
      ["site", 5],
    ]);

    await deliver("installation_repositories", {
      action: "removed",
      installation,
      repositories_removed: [{ full_name: "acme/site" }],
    });
    expect(store.getRepo("acme", "site")?.installationId).toBeNull();

    await deliver("installation", { action: "deleted", installation });
    expect(store.getRepo("acme", "app")?.installationId).toBeNull();
  });

  it("rejects a payload it can't read and ignores events it doesn't use", async () => {
    await expect(handleWebhook(deps, "pull_request", { action: "opened" })).rejects.toThrow();
    expect(await deliver("issue_comment", {})).toBe("ignored issue_comment");
  });

  it("folds a burst of events for one PR into at most two runs", async () => {
    const payload = { action: "synchronize", pull_request: { number: 1 }, repository, installation };
    await Promise.all(Array.from({ length: 6 }, () => handleWebhook(deps, "pull_request", payload)));
    await deps.queue.idle();
    expect(github.reports.length).toBeLessThanOrEqual(2);
    expect(github.reports.length).toBeGreaterThanOrEqual(1);
  });
});
