import {
  AppShell,
  Badge,
  Button,
  buttonClass,
  EmptyState,
  MenuItem,
  ProfileMenu,
  SegmentedControl,
  Select,
  Spinner,
  ThemeMenuItem,
  useToast,
  Wordmark,
} from "@pluscosmic/ui";
import { IconLogout } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PolicyEdit } from "../../src/policy/edit";
import { api, type RunnerStatus } from "./api";
import { Canvas, type AddTarget } from "./Canvas";
import { copy } from "./copy/app";
import { Inspector } from "./Inspector";
import { PullDetail, PullList } from "./Pulls";
import { replay as replayPulls } from "./trace";
import { useEditor } from "./useEditor";
import { YamlPane } from "./YamlPane";

type Tab = "node" | "pull" | "yaml";

const IMPORT_LIMIT = 40;
/** Until the first simulation says otherwise. */
const NO_RUNNER: RunnerStatus = { online: false, models: [], queued: 0 };

function pullFromUrl(): number | null {
  const value = Number(new URLSearchParams(window.location.search).get("pr"));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function App() {
  const editor = useEditor();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("node");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedPull, setSelectedPull] = useState<number | null>(pullFromUrl);
  const [adding, setAdding] = useState<AddTarget | null>(null);
  const [busy, setBusy] = useState<"import" | "propose" | "evaluate" | null>(null);

  const { simulation, repo, me } = editor;
  const graph = simulation?.graph ?? null;
  const pulls = useMemo(() => simulation?.pulls ?? [], [simulation]);
  const replay = useMemo(() => (graph ? replayPulls(graph, pulls) : null), [graph, pulls]);

  const node = graph?.nodes.find((candidate) => candidate.id === selectedNode) ?? null;
  const pull = pulls.find((candidate) => candidate.number === selectedPull) ?? null;
  const trace = (pull && replay?.traces.get(pull.number)) ?? null;

  const apply = useCallback(
    (edit: PolicyEdit): boolean => {
      const error = editor.apply(edit);
      if (error !== null) toast.show({ message: copy.errors.edit(error), tone: "error" });
      return error === null;
    },
    [editor, toast],
  );

  const selectNode = useCallback((id: string | null) => {
    setSelectedNode(id);
    setAdding(null);
    if (id !== null) setTab("node");
  }, []);

  const selectPull = useCallback((number: number | null) => {
    setSelectedPull(number);
    if (number !== null) setTab("pull");
  }, []);

  const startAdding = useCallback((target: AddTarget) => {
    setAdding(target);
    setSelectedNode(null);
    setTab("node");
  }, []);

  // Changing repository leaves nothing of the old one selected.
  useEffect(() => {
    setSelectedNode(null);
    setAdding(null);
  }, [repo]);

  if (editor.phase === "loading") {
    return (
      <div className="wl-centered">
        <Spinner />
        <span className="wl-muted">{copy.loading}</span>
      </div>
    );
  }
  if (editor.phase === "signed-out") {
    return (
      <div className="wl-centered">
        <EmptyState
          title={copy.signIn.title}
          actions={
            <a className={buttonClass("primary")} href="/auth/login">
              {copy.signIn.action}
            </a>
          }
        >
          {copy.signIn.body}
        </EmptyState>
      </div>
    );
  }
  if (editor.phase === "failed" || !me) {
    return (
      <div className="wl-centered">
        <EmptyState title={copy.failed.title} actions={<Button onClick={editor.retry}>{copy.failed.retry}</Button>}>
          {editor.failure || copy.errors.generic}
        </EmptyState>
      </div>
    );
  }

  const summary = editor.repos.find((candidate) => `${candidate.owner}/${candidate.name}` === repo);
  const isFixtures = repo === "windlass/fixtures";
  const valid = simulation?.policy.ok ?? false;
  // In dev mode a personal token can read GitHub; the server says so if it can't.
  const canImport = !isFixtures && (me.mode === "dev" || (summary?.connected ?? false));

  const importPulls = async () => {
    if (!repo) return;
    setBusy("import");
    try {
      const { imported } = await api.importPulls(repo, IMPORT_LIMIT);
      await editor.refresh();
      toast.show({ message: copy.pulls.imported(imported) });
    } catch (error) {
      toast.show({ message: (error instanceof Error && error.message) || copy.errors.generic, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const propose = async () => {
    if (!repo) return;
    setBusy("propose");
    try {
      const { url } = await api.propose(repo, editor.source);
      toast.show({
        message: copy.toolbar.proposed,
        extra: (
          <a className="wl-link" href={url} target="_blank" rel="noreferrer">
            {copy.toolbar.view}
          </a>
        ),
      });
    } catch (error) {
      toast.show({ message: (error instanceof Error && error.message) || copy.errors.generic, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const runEvaluators = async () => {
    setBusy("evaluate");
    try {
      toast.show({ message: copy.inspector.evaluator.runs.asked(await editor.evaluate()) });
    } catch (error) {
      toast.show({ message: (error instanceof Error && error.message) || copy.errors.generic, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const copyYaml = async () => {
    await navigator.clipboard.writeText(editor.source);
    toast.show({ message: copy.toolbar.copied });
  };

  return (
    <AppShell
      className="wl-app"
      brand={<Wordmark>{copy.brand}</Wordmark>}
      nav={
        editor.repos.length > 0 && repo ? (
          <Select
            aria-label={copy.repo.label}
            className="wl-repo-select"
            value={repo}
            options={editor.repos.map((r) => ({ value: `${r.owner}/${r.name}`, label: `${r.owner}/${r.name}` }))}
            onValueChange={(next) => {
              setSelectedPull(null);
              editor.selectRepo(next);
            }}
          />
        ) : undefined
      }
      actions={
        <>
          {editor.simulating ? <Spinner /> : null}
          {simulation ? (
            <Badge tone={!valid ? "danger" : editor.dirty ? "accent" : "neutral"}>
              {!valid ? copy.toolbar.invalid : editor.dirty ? copy.toolbar.draft : copy.toolbar.saved}
            </Badge>
          ) : null}
          <Button variant="ghost" disabled={!editor.canUndo} onClick={editor.undo}>
            {copy.toolbar.undo}
          </Button>
          <Button variant="ghost" disabled={!editor.dirty} onClick={editor.discard}>
            {copy.toolbar.reset}
          </Button>
          <Button onClick={() => void copyYaml()}>{copy.toolbar.copy}</Button>
          <Button
            variant="primary"
            disabled={me.mode === "dev" || !editor.dirty || !valid || busy === "propose"}
            title={me.mode === "dev" ? copy.toolbar.proposeDevHint : undefined}
            onClick={() => void propose()}
          >
            {busy === "propose" ? copy.toolbar.proposing : copy.toolbar.propose}
          </Button>
          <ProfileMenu name={me.login} header={me.mode === "dev" ? copy.menu.dev : copy.menu.signedInAs(me.login)}>
            <ThemeMenuItem />
            {me.mode === "app" ? (
              <MenuItem onClick={() => void api.signOut().then(() => window.location.reload())}>
                <IconLogout size={16} aria-hidden="true" />
                {copy.menu.signOut}
              </MenuItem>
            ) : null}
          </ProfileMenu>
        </>
      }
    >
      {!repo ? (
        <div className="wl-centered">
          <EmptyState title={copy.repo.none.title}>
            {me.mode === "dev" ? copy.repo.none.dev : copy.repo.none.app}
          </EmptyState>
        </div>
      ) : (
        <div className="wl-editor">
          <aside className="wl-side wl-side-left">
            {simulation ? (
              <PullList
                pulls={pulls}
                selected={selectedPull}
                onSelect={selectPull}
                canImport={canImport}
                importing={busy === "import"}
                onImport={() => void importPulls()}
              />
            ) : null}
          </aside>

          <section className="wl-canvas" aria-label={copy.panel.tabs.node}>
            {graph && replay ? (
              <Canvas
                graph={graph}
                replay={replay}
                trace={trace}
                selected={adding ? null : selectedNode}
                onSelect={selectNode}
                onAdd={startAdding}
              />
            ) : simulation ? (
              <div className="wl-centered">
                <EmptyState title={copy.canvas.undrawable.title}>{copy.canvas.undrawable.body}</EmptyState>
              </div>
            ) : (
              <div className="wl-centered">
                <Spinner />
              </div>
            )}
          </section>

          <aside className="wl-side wl-side-right">
            <SegmentedControl
              className="wl-tabs"
              aria-label={copy.panel.tabs.label}
              value={tab}
              options={[
                { value: "node", label: copy.panel.tabs.node },
                { value: "pull", label: copy.panel.tabs.pull },
                { value: "yaml", label: copy.panel.tabs.yaml },
              ]}
              onChange={setTab}
            />
            {tab === "yaml" ? (
              <YamlPane source={editor.source} errors={simulation?.policy.errors ?? []} onChange={editor.write} />
            ) : tab === "pull" ? (
              <PullDetail
                pull={pull}
                trace={trace}
                graph={graph}
                githubRepo={isFixtures ? null : repo}
                onSelectNode={selectNode}
              />
            ) : graph && replay ? (
              <Inspector
                graph={graph}
                node={node}
                adding={adding}
                source={editor.source}
                gates={me.gates}
                evaluators={me.evaluators}
                runner={simulation?.evaluators ?? NO_RUNNER}
                replay={replay}
                pulls={pulls}
                selectedPull={selectedPull}
                valid={valid}
                running={busy === "evaluate"}
                apply={apply}
                onSelectNode={selectNode}
                onSelectPull={selectPull}
                onCancelAdd={() => setAdding(null)}
                onRunEvaluators={() => void runEvaluators()}
              />
            ) : null}
          </aside>
        </div>
      )}
    </AppShell>
  );
}
