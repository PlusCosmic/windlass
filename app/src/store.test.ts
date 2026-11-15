import { describe, expect, it } from "vitest";
import { KeyedQueue } from "./queue.js";
import { Store } from "./store.js";

describe("Store", () => {
  it("finds repos whatever the case, and keeps their installation unless told otherwise", () => {
    const store = new Store(":memory:");
    const repo = store.upsertRepo("PlusCosmic", "reelshelf", 9);
    expect(store.upsertRepo("PlusCosmic", "reelshelf")).toEqual(repo);
    expect(store.getRepo("pluscosmic", "Reelshelf")?.installationId).toBe(9);
    expect(store.getRepo("pluscosmic", "other")).toBeNull();
    store.detachInstallation(9);
    expect(store.getRepo("PlusCosmic", "reelshelf")?.installationId).toBeNull();
  });

  it("keeps one row per PR, newest first, replacing it when the PR changes", () => {
    const store = new Store(":memory:");
    const repo = store.upsertRepo("acme", "app");
    const input = { baseSha: "a", headSha: "b", body: "", diff: "" };
    const row = {
      repoId: repo.id,
      title: "One",
      author: "agent",
      state: "open" as const,
      headSha: "b",
      input,
      decision: null,
      updatedAt: "t",
    };
    store.savePull({ ...row, number: 1 });
    store.savePull({ ...row, number: 2 });
    store.savePull({ ...row, number: 1, title: "One, renamed", headSha: "c" });
    expect(store.listPulls(repo.id).map((p) => [p.number, p.title, p.headSha])).toEqual([
      [2, "One", "b"],
      [1, "One, renamed", "c"],
    ]);
    store.setPullState(repo.id, 2, "merged");
    expect(store.listPulls(repo.id)[0]?.state).toBe("merged");
  });
});

describe("KeyedQueue", () => {
  it("runs one job per key at a time, once more for anything that arrived meanwhile", async () => {
    const queue = new KeyedQueue(() => {});
    let active = 0;
    let most = 0;
    let runs = 0;
    const job = async () => {
      most = Math.max(most, ++active);
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };
    for (let i = 0; i < 5; i++) queue.run("a", job);
    queue.run("b", job);
    await queue.idle();
    expect(runs).toBe(3);
    expect(most).toBe(2);
  });

  it("reports a failed job and carries on", async () => {
    const errors: string[] = [];
    const queue = new KeyedQueue((key, error) => errors.push(`${key}: ${(error as Error).message}`));
    queue.run("a", async () => {
      throw new Error("boom");
    });
    await queue.idle();
    let ran = false;
    queue.run("a", async () => {
      ran = true;
    });
    await queue.idle();
    expect(errors).toEqual(["a: boom"]);
    expect(ran).toBe(true);
  });
});
