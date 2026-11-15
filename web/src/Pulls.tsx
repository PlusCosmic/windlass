import { Button, Chip, ChipRow, cx, EmptyState } from "@pluscosmic/ui";
import { IconExternalLink } from "@tabler/icons-react";
import { useState } from "react";
import type { FlowGraph, Trace } from "../../src/graph";
import type { SimulatedPull } from "./api";
import { copy } from "./copy/app";
import { countOutcomes } from "./trace";

type Outcome = SimulatedPull["draft"]["outcome"];

function OutcomeMark({ outcome }: { outcome: Outcome }) {
  return (
    <span className={`wl-outcome wl-tone-${outcome}`}>
      <span className="wl-dot" />
      {copy.outcomeNoun[outcome]}
    </span>
  );
}

interface PullListProps {
  pulls: SimulatedPull[];
  selected: number | null;
  onSelect: (number: number | null) => void;
  /** Shown when there are no pull requests: whether importing can work, and how to start it. */
  canImport: boolean;
  importing: boolean;
  onImport: () => void;
}

export function PullList({ pulls, selected, onSelect, canImport, importing, onImport }: PullListProps) {
  const [filter, setFilter] = useState<"all" | "changed">("all");
  const changed = pulls.filter((pull) => pull.current.outcome !== pull.draft.outcome);
  const shown = filter === "changed" ? changed : pulls;
  const counts = countOutcomes(pulls, "draft");

  if (pulls.length === 0) {
    return (
      <div className="wl-pulls">
        <EmptyState
          title={copy.pulls.empty.title}
          actions={
            canImport ? (
              <Button variant="primary" disabled={importing} onClick={onImport}>
                {importing ? copy.pulls.empty.importing : copy.pulls.empty.action}
              </Button>
            ) : null
          }
        >
          {canImport ? copy.pulls.empty.body : copy.pulls.empty.unreachable}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="wl-pulls">
      <header className="wl-pulls-head">
        <h2 className="ui-eyebrow">{copy.pulls.title}</h2>
        <p className="wl-muted">{copy.pulls.replayed(pulls.length)}</p>
        <div className="wl-tally">
          {(["merge", "escalate", "block", "pending"] as const).map((outcome) =>
            counts[outcome] === 0 && outcome === "pending" ? null : (
              <span key={outcome} className={`wl-tally-item wl-tone-${outcome}`}>
                <strong>{counts[outcome]}</strong>
                {copy.outcome[outcome]}
              </span>
            ),
          )}
        </div>
        <ChipRow aria-label={copy.pulls.filter.label}>
          <Chip active={filter === "all"} onClick={() => setFilter("all")}>
            {copy.pulls.filter.all} · {pulls.length}
          </Chip>
          <Chip active={filter === "changed"} onClick={() => setFilter("changed")}>
            {copy.pulls.filter.changed} · {changed.length}
          </Chip>
        </ChipRow>
      </header>
      {shown.length === 0 ? <p className="wl-muted wl-pulls-none">{copy.pulls.noneChanged}</p> : null}
      <ul className="wl-pull-list">
        {shown.map((pull) => {
          const moved = pull.current.outcome !== pull.draft.outcome;
          return (
            <li key={pull.number}>
              <button
                type="button"
                className={cx("wl-pull", selected === pull.number && "wl-selected")}
                aria-pressed={selected === pull.number}
                onClick={() => onSelect(selected === pull.number ? null : pull.number)}
              >
                <span className="wl-pull-title">
                  <span className="wl-pull-number">#{pull.number}</span> {pull.title}
                </span>
                <span className="wl-pull-meta">
                  <span className="wl-code">{pull.draft.intent?.category ?? copy.pulls.noCategory}</span>
                  <OutcomeMark outcome={pull.draft.outcome} />
                  {moved ? (
                    <span className="wl-was">{copy.pulls.was(copy.outcomeNoun[pull.current.outcome])}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const MAX_EVIDENCE = 8;

interface PullDetailProps {
  pull: SimulatedPull | null;
  trace: Trace | null;
  graph: FlowGraph | null;
  /** `owner/name` on GitHub, or null when the pull requests aren't from there (the bundled fixtures). */
  githubRepo: string | null;
  onSelectNode: (id: string) => void;
}

export function PullDetail({ pull, trace, graph, githubRepo, onSelectNode }: PullDetailProps) {
  if (!pull) {
    return (
      <div className="wl-inspector">
        <EmptyState title={copy.detail.empty.title}>{copy.detail.empty.body}</EmptyState>
      </div>
    );
  }
  const { draft, current } = pull;
  const known = new Set(graph?.nodes.map((node) => node.id));
  const steps = [
    ...draft.builtins.map((b) => ({
      node: b.node as string,
      status: b.status as string,
      reason: b.reason,
      evidence: [] as (typeof draft.gates)[number]["evidence"],
    })),
    ...draft.gates.map((g) => ({ node: g.node, status: g.status as string, reason: g.reason, evidence: g.evidence })),
    ...draft.evaluators.map((e) => ({
      node: e.node,
      status: e.status as string,
      reason: e.reason,
      evidence: e.evidence,
    })),
  ];

  return (
    <div className="wl-inspector">
      <header>
        <p className="ui-eyebrow">
          #{pull.number} · {copy.pulls.state[pull.state]} · {copy.detail.by(pull.author)}
        </p>
        <h2 className="wl-heading">{pull.title}</h2>
        {githubRepo ? (
          <a
            className="wl-link"
            href={`https://github.com/${githubRepo}/pull/${pull.number}`}
            target="_blank"
            rel="noreferrer"
          >
            {copy.detail.openOnGitHub} <IconExternalLink size={13} aria-hidden="true" />
          </a>
        ) : null}
      </header>

      <dl className="wl-facts">
        <dt>{copy.detail.declared}</dt>
        <dd className="wl-code">{draft.intent?.category ?? copy.detail.noIntent}</dd>
        {draft.changes ? (
          <>
            <dt />
            <dd>{copy.detail.changes(draft.changes.files.length, draft.changes.additions, draft.changes.deletions)}</dd>
          </>
        ) : null}
        <dt>{copy.detail.underDraft}</dt>
        <dd>
          <OutcomeMark outcome={draft.outcome} />
        </dd>
        <dt>{copy.detail.underCurrent}</dt>
        <dd>
          <OutcomeMark outcome={current.outcome} />
        </dd>
      </dl>

      <section className="wl-section">
        <h3 className="ui-eyebrow">{copy.detail.reasons}</h3>
        {draft.reasons.length === 0 ? (
          <p className="wl-muted">{copy.detail.noReasons}</p>
        ) : (
          <ul className="wl-reasons">
            {draft.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="wl-section">
        <h3 className="ui-eyebrow">{copy.detail.nodes}</h3>
        <ol className="wl-steps">
          {steps.map((step) => (
            <li key={step.node} className={`wl-step wl-status-${step.status}`}>
              <button
                type="button"
                className="wl-step-head"
                disabled={!known.has(step.node)}
                onClick={() => onSelectNode(step.node)}
              >
                <span className="wl-step-status">
                  {copy.canvas.status[trace?.nodes[step.node] ?? (step.status as "pass")]}
                </span>
                <span className="wl-code">{step.node}</span>
              </button>
              {step.reason ? <p className="wl-step-reason">{step.reason}</p> : null}
              {step.evidence.length > 0 ? (
                <ul className="wl-evidence">
                  {step.evidence.slice(0, MAX_EVIDENCE).map((item, i) => (
                    <li key={i}>
                      <span className="wl-code">
                        {item.line === undefined ? item.file : `${item.file}:${item.line}`}
                      </span>
                      <span className="wl-evidence-detail">{item.detail}</span>
                    </li>
                  ))}
                  {step.evidence.length > MAX_EVIDENCE ? (
                    <li className="wl-muted">{copy.detail.more(step.evidence.length - MAX_EVIDENCE)}</li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
