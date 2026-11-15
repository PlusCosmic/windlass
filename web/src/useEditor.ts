import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyEdit, type PolicyEdit } from "../../src/policy/edit";
import { api, ApiError, type Me, type RepoSummary, type SimulationResponse } from "./api";

export type Phase = "loading" | "signed-out" | "failed" | "ready";

export interface Editor {
  phase: Phase;
  failure: string;
  me: Me | null;
  repos: RepoSummary[];
  repo: string | null;
  selectRepo: (repo: string) => void;
  /** The policy the canvas shows: the draft, or the default branch's when there is none. */
  source: string;
  /** True when the draft differs from the default branch. */
  dirty: boolean;
  simulation: SimulationResponse | null;
  simulating: boolean;
  canUndo: boolean;
  /** Makes a structured change. Returns the error message when it can't be made. */
  apply: (edit: PolicyEdit) => string | null;
  /** Replaces the whole source, as typed in the YAML pane. */
  write: (source: string) => void;
  undo: () => void;
  discard: () => void;
  /** Runs the simulation again, after the stored pull requests changed. */
  refresh: () => Promise<void>;
  retry: () => void;
}

const UNDO_LIMIT = 100;

interface Draft {
  /** Null while the editor shows the default branch's policy unchanged. */
  draft: string | null;
  history: (string | null)[];
}

const NO_DRAFT: Draft = { draft: null, history: [] };

function repoFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("repo");
}

/** Prefers the repo in the URL, then a real one with pull requests, over the bundled fixtures. */
function pickRepo(repos: RepoSummary[]): string | null {
  const names = repos.map((repo) => `${repo.owner}/${repo.name}`);
  const asked = repoFromUrl()?.toLowerCase();
  const wanted = names.find((name) => name.toLowerCase() === asked);
  if (wanted) return wanted;
  const ranked = [...repos].sort((a, b) => Number(b.connected) - Number(a.connected) || b.pulls - a.pulls);
  const best = ranked.find((repo) => repo.owner !== "windlass" || repo.name !== "fixtures") ?? ranked[0];
  return best ? `${best.owner}/${best.name}` : null;
}

export function useEditor(): Editor {
  const [phase, setPhase] = useState<Phase>("loading");
  const [failure, setFailure] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  // The draft and its undo history change together, so they are one piece of state.
  const [{ draft, history }, setDocument] = useState<Draft>(NO_DRAFT);
  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [revision, setRevision] = useState(0);

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) setPhase("signed-out");
    else {
      setFailure(error instanceof Error ? error.message : "");
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    Promise.all([api.me(), api.repos()])
      .then(([who, list]) => {
        if (cancelled) return;
        setMe(who);
        setRepos(list);
        setRepo(pickRepo(list));
        setPhase("ready");
      })
      .catch((error: unknown) => !cancelled && fail(error));
    return () => {
      cancelled = true;
    };
  }, [attempt, fail]);

  const saved = simulation?.source ?? null;
  // A draft equal to the saved policy is no draft: the server compares the same policy against itself.
  const effectiveDraft = draft !== null && draft !== saved ? draft : null;

  // Typing in the YAML pane fires this on every key, so wait for a pause; the first load doesn't wait.
  const first = useRef(true);
  useEffect(() => {
    if (phase !== "ready" || repo === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        setSimulating(true);
        api
          .simulate(repo, effectiveDraft, controller.signal)
          .then((result) => {
            setSimulation(result);
            setSimulating(false);
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setSimulating(false);
            fail(error);
          });
      },
      first.current ? 0 : 180,
    );
    first.current = false;
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [phase, repo, effectiveDraft, revision, fail]);

  const source = draft ?? saved ?? "";

  const change = useCallback((next: string | null) => {
    setDocument((current) =>
      current.draft === next
        ? current
        : { draft: next, history: [...current.history.slice(1 - UNDO_LIMIT), current.draft] },
    );
  }, []);

  const apply = useCallback(
    (edit: PolicyEdit): string | null => {
      try {
        change(applyEdit(source, edit));
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [source, change],
  );

  const undo = useCallback(() => {
    setDocument((current) =>
      current.history.length === 0
        ? current
        : { draft: current.history.at(-1) ?? null, history: current.history.slice(0, -1) },
    );
  }, []);

  const selectRepo = useCallback((next: string) => {
    setRepo(next);
    setDocument(NO_DRAFT);
    setSimulation(null);
    first.current = true;
    const url = new URL(window.location.href);
    url.searchParams.set("repo", next);
    url.searchParams.delete("pr");
    window.history.replaceState(null, "", url);
  }, []);

  const refresh = useCallback(async () => {
    setRepos(await api.repos());
    setRevision((n) => n + 1);
  }, []);

  return useMemo(
    () => ({
      phase,
      failure,
      me,
      repos,
      repo,
      selectRepo,
      source,
      dirty: effectiveDraft !== null,
      simulation,
      simulating,
      canUndo: history.length > 0,
      apply,
      write: change,
      undo,
      discard: () => change(null),
      refresh,
      retry: () => setAttempt((n) => n + 1),
    }),
    [
      phase,
      failure,
      me,
      repos,
      repo,
      selectRepo,
      source,
      effectiveDraft,
      simulation,
      simulating,
      history.length,
      apply,
      change,
      undo,
      refresh,
    ],
  );
}
