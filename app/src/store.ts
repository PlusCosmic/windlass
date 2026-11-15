import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DecisionRecord, PullRequestInput } from "../../src/index.js";

export interface Repo {
  id: number;
  owner: string;
  name: string;
  /** The App installation that can reach it; null in dev mode or once the App is uninstalled. */
  installationId: number | null;
  /** The policy on the default branch, as last seen. */
  policySource: string | null;
}

export type PullState = "open" | "closed" | "merged";

/** A PR as Windlass last saw it: what it needs to decide it again, and what it decided. */
export interface StoredPull {
  repoId: number;
  number: number;
  title: string;
  author: string;
  state: PullState;
  headSha: string;
  input: PullRequestInput;
  /** Null when no decision has been made for this head (imported PRs are only ever simulated). */
  decision: DecisionRecord | null;
  updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  installation_id INTEGER,
  policy_source TEXT,
  UNIQUE (owner, name)
);
CREATE TABLE IF NOT EXISTS pulls (
  repo_id INTEGER NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  state TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  input TEXT NOT NULL,
  decision TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
);
-- Every decision Windlass has reported, never rewritten.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  outcome TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  record TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_by_pull ON decisions (repo_id, number, id);
`;

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  installation_id: number | null;
  policy_source: string | null;
}

interface PullRow {
  repo_id: number;
  number: number;
  title: string;
  author: string;
  state: string;
  head_sha: string;
  input: string;
  decision: string | null;
  updated_at: string;
}

/** Windlass's own state: the repos it watches, the PRs it has seen and the decisions it has made. */
export class Store {
  private readonly db: DatabaseSync;

  /** `dir` holds the database file; `:memory:` keeps it in memory, for tests. */
  constructor(dir: string) {
    if (dir === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      mkdirSync(dir, { recursive: true });
      this.db = new DatabaseSync(join(dir, "windlass.db"));
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Adds the repo if it's new. `installationId` is left alone when not given. */
  upsertRepo(owner: string, name: string, installationId?: number | null): Repo {
    this.db
      .prepare("INSERT INTO repos (owner, name) VALUES (?, ?) ON CONFLICT (owner, name) DO NOTHING")
      .run(owner, name);
    if (installationId !== undefined) {
      this.db
        .prepare("UPDATE repos SET installation_id = ? WHERE owner = ? AND name = ?")
        .run(installationId, owner, name);
    }
    return this.getRepo(owner, name)!;
  }

  getRepo(owner: string, name: string): Repo | null {
    const row = this.db
      .prepare("SELECT * FROM repos WHERE owner = ? COLLATE NOCASE AND name = ? COLLATE NOCASE")
      .get(owner, name) as RepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  listRepos(): Repo[] {
    return (this.db.prepare("SELECT * FROM repos ORDER BY owner, name").all() as unknown as RepoRow[]).map(toRepo);
  }

  /** Forgets which installation reaches these repos, when the App is uninstalled or a repo is removed from it. */
  detachInstallation(installationId: number, only?: { owner: string; name: string }[]): void {
    if (!only) {
      this.db.prepare("UPDATE repos SET installation_id = NULL WHERE installation_id = ?").run(installationId);
      return;
    }
    const statement = this.db.prepare(
      "UPDATE repos SET installation_id = NULL WHERE installation_id = ? AND owner = ? AND name = ?",
    );
    for (const repo of only) statement.run(installationId, repo.owner, repo.name);
  }

  setPolicySource(repoId: number, source: string | null): void {
    this.db.prepare("UPDATE repos SET policy_source = ? WHERE id = ?").run(source, repoId);
  }

  savePull(pull: StoredPull): void {
    this.db
      .prepare(
        `INSERT INTO pulls (repo_id, number, title, author, state, head_sha, input, decision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, number) DO UPDATE SET
           title = excluded.title, author = excluded.author, state = excluded.state, head_sha = excluded.head_sha,
           input = excluded.input, decision = excluded.decision, updated_at = excluded.updated_at`,
      )
      .run(
        pull.repoId,
        pull.number,
        pull.title,
        pull.author,
        pull.state,
        pull.headSha,
        JSON.stringify(pull.input),
        pull.decision ? JSON.stringify(pull.decision) : null,
        pull.updatedAt,
      );
  }

  setPullState(repoId: number, number: number, state: PullState): void {
    this.db.prepare("UPDATE pulls SET state = ? WHERE repo_id = ? AND number = ?").run(state, repoId, number);
  }

  /** Newest PR first. */
  listPulls(repoId: number): StoredPull[] {
    const rows = this.db.prepare("SELECT * FROM pulls WHERE repo_id = ? ORDER BY number DESC").all(repoId);
    return (rows as unknown as PullRow[]).map(toPull);
  }

  logDecision(repoId: number, number: number, record: DecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO decisions (repo_id, number, head_sha, outcome, policy_hash, record, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repoId,
        number,
        record.headSha,
        record.outcome,
        record.policy.hash,
        JSON.stringify(record),
        record.decidedAt,
      );
  }

  countDecisions(repoId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE repo_id = ?").get(repoId) as { n: number };
    return row.n;
  }
}

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    installationId: row.installation_id,
    policySource: row.policy_source,
  };
}

function toPull(row: PullRow): StoredPull {
  return {
    repoId: row.repo_id,
    number: row.number,
    title: row.title,
    author: row.author,
    state: row.state as PullState,
    headSha: row.head_sha,
    input: JSON.parse(row.input) as PullRequestInput,
    decision: row.decision ? (JSON.parse(row.decision) as DecisionRecord) : null,
    updatedAt: row.updated_at,
  };
}
