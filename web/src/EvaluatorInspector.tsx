import { Button, cx, Field, Input, Notice, Select, Spinner, Textarea } from "@pluscosmic/ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { EvaluatorRecord } from "../../src/decision";
import type { FlowGraph, FlowNode } from "../../src/graph";
import type { PolicyEdit } from "../../src/policy/edit";
import type { EvaluatorCatalog, RunnerStatus, SimulatedPull } from "./api";
import { copy } from "./copy/app";
import {
  DEFAULT_MIN_CONFIDENCE,
  EVALUATOR_NAME,
  evaluatorId,
  evaluatorRuns,
  formatConfidence,
  readEvaluator,
  RUN_STATUSES,
  type EvaluatorRun,
  type RunStatus,
} from "./evaluators";
import { Problems } from "./Problems";

type EvaluatorNode = Extract<FlowNode, { kind: "evaluator" }>;
type EvaluatorChange = Omit<Extract<PolicyEdit, { type: "set_evaluator" }>, "type" | "at">;
type Apply = (edit: PolicyEdit) => boolean;

const text = copy.inspector.evaluator;

const MIN_CONFIDENCE = 0.5;
const CONFIDENCE_STEP = 0.05;

/** The names a question can use, as they are written in one, then what they and a pass mean. */
function QuestionHint({ placeholders }: { placeholders: readonly string[] }) {
  if (placeholders.length === 0) return text.passMeansYes;
  return (
    <>
      {placeholders.map((name, i) => (
        <Fragment key={name}>
          {i > 0 ? ", " : null}
          <code className="wl-code">{`{{${name}}}`}</code>
        </Fragment>
      ))}{" "}
      {text.questionHint} {text.passMeansYes}
    </>
  );
}

/**
 * The question as prose. Keeps what is typed, trailing spaces and all, until the value changes from outside,
 * and never writes an empty question: the draft keeps the last one.
 */
function QuestionField({
  value,
  placeholders,
  onChange,
}: {
  value: string;
  placeholders: readonly string[];
  onChange: (next: string) => void;
}) {
  const [typed, setTyped] = useState(value);
  useEffect(() => {
    setTyped((current) => (current.trim() === value.trim() ? current : value));
  }, [value]);
  const empty = typed.trim() === "";

  return (
    <Field
      label={text.question}
      hint={<QuestionHint placeholders={placeholders} />}
      error={empty ? text.questionEmpty : null}
    >
      <Textarea
        className="wl-question"
        value={typed}
        rows={8}
        aria-invalid={empty}
        onChange={(event) => {
          setTyped(event.target.value);
          const next = event.target.value.trim();
          if (next !== "" && next !== value.trim()) onChange(next);
        }}
      />
    </Field>
  );
}

/** A slider that changes the draft when it is let go of, not at every step on the way. */
function ConfidenceField({ value, onCommit }: { value: number; onCommit: (next: number) => void }) {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
    setShown(value);
  }, [value]);
  const commit = () => {
    if (latest.current !== value) onCommit(latest.current);
  };

  return (
    <Field label={text.confidence} hint={text.confidenceHint}>
      <span className="wl-range">
        <input
          type="range"
          min={MIN_CONFIDENCE}
          max={1}
          step={CONFIDENCE_STEP}
          // A policy can ask for less than the slider offers; the number beside it says what it really is.
          value={Math.max(MIN_CONFIDENCE, shown)}
          onChange={(event) => {
            const next = Math.round(Number(event.target.value) * 100) / 100;
            latest.current = next;
            setShown(next);
          }}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <output className="wl-code">{formatConfidence(shown)}</output>
      </span>
    </Field>
  );
}

function verdictLabel({ record, status, waiting }: EvaluatorRun): string {
  if (waiting) return text.runs.waiting;
  const label = text.runs.status[status];
  return record.confidence === null ? label : `${label} ${formatConfidence(record.confidence)}`;
}

/** One line on why a pull request didn't pass: what the model pointed at, or what went wrong. */
function why(record: EvaluatorRecord): string | null {
  switch (record.status) {
    case "fail": {
      const [first, ...rest] = record.evidence;
      if (!first) return record.reason;
      return rest.length > 0 ? `${first.detail} ${text.runs.moreEvidence(rest.length)}` : first.detail;
    }
    case "low_confidence":
      return record.verdict !== null && record.confidence !== null
        ? text.runs.unsure(record.verdict, formatConfidence(record.confidence), formatConfidence(record.minConfidence))
        : record.reason;
    case "error":
      return record.reason;
    default:
      return null;
  }
}

const STATUS_TONE: Record<RunStatus, string> = {
  pass: "wl-tone-merge",
  fail: "wl-tone-escalate",
  low_confidence: "wl-tone-escalate",
  error: "wl-tone-block",
  not_run: "wl-tone-idle",
};

/** How the stored pull requests that reach this evaluator fare, and the button that asks about the rest. */
function Runs({
  node,
  pulls,
  runner,
  valid,
  running,
  selectedPull,
  onSelectPull,
  onRun,
}: {
  node: EvaluatorNode;
  pulls: SimulatedPull[];
  runner: RunnerStatus;
  valid: boolean;
  running: boolean;
  selectedPull: number | null;
  onSelectPull: (number: number) => void;
  onRun: () => void;
}) {
  const { runs, counts, runnable } = useMemo(() => evaluatorRuns(node.id, pulls), [node.id, pulls]);
  // Asked, and the answers aren't all back: there is nothing more to run, but it isn't done either.
  const asking = running || (runnable === 0 && runs.some((run) => run.waiting));

  return (
    <section className="wl-section">
      <h3 className="ui-eyebrow">{text.runs.title}</h3>
      {runs.length === 0 ? (
        <p className="wl-muted">{text.runs.none}</p>
      ) : (
        <>
          <p className="wl-muted">{text.runs.reach(runs.length)}</p>
          <div className="wl-tally">
            {RUN_STATUSES.map((status) =>
              status === "error" && counts.error === 0 ? null : (
                <span key={status} className={cx("wl-tally-item", STATUS_TONE[status])}>
                  <strong>{counts[status]}</strong>
                  {text.runs.status[status]}
                </span>
              ),
            )}
          </div>
          <ul className="wl-runs">
            {runs.map((run) => {
              const reason = why(run.record);
              return (
                <li key={run.pull.number}>
                  <button
                    type="button"
                    className={cx("wl-run", selectedPull === run.pull.number && "wl-selected")}
                    onClick={() => onSelectPull(run.pull.number)}
                  >
                    <span className="wl-run-title">
                      <span className="wl-pull-number">#{run.pull.number}</span> {run.pull.title}
                    </span>
                    <span className={cx("wl-verdict", STATUS_TONE[run.status])}>{verdictLabel(run)}</span>
                    {reason ? <span className="wl-run-why">{reason}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="wl-run-actions">
        <Button variant="primary" disabled={!runner.online || !valid || running || runnable === 0} onClick={onRun}>
          {asking ? text.runs.asking : runnable === 0 ? text.runs.nothingToRun : text.runs.run(runnable)}
        </Button>
        {runner.queued > 0 ? (
          <span className="wl-queued">
            <Spinner />
            {text.runs.queued(runner.queued)}
          </span>
        ) : null}
      </div>
      {!runner.online ? (
        <Notice tone="warning" compact>
          {text.runs.offline}
        </Notice>
      ) : (
        <p className="wl-muted">{valid ? text.runs.stored : text.runs.invalid}</p>
      )}
    </section>
  );
}

export interface EvaluatorInspectorProps {
  node: EvaluatorNode;
  source: string;
  catalog: EvaluatorCatalog;
  runner: RunnerStatus;
  pulls: SimulatedPull[];
  selectedPull: number | null;
  /** Whether the draft is a valid policy; an invalid one can't be run. */
  valid: boolean;
  /** A request to run the evaluators is on its way. */
  running: boolean;
  apply: Apply;
  onSelectNode: (id: string | null) => void;
  onSelectPull: (number: number) => void;
  onRun: () => void;
}

export function EvaluatorInspector(props: EvaluatorInspectorProps) {
  const { node, source, catalog, runner, apply, onSelectNode } = props;
  const [name, setName] = useState(node.evaluator);

  // As written in the draft, so that typing shows at once; the graph's values lag a replay behind.
  const raw = readEvaluator(source, node.ref);
  const preset = catalog.presets.find((candidate) => candidate.name === node.evaluator);
  const written = raw ? raw.question : node.questionFromPreset ? null : node.question;
  const question = written ?? preset?.question ?? node.question;
  const minConfidence = raw?.minConfidence ?? node.minConfidence;
  const model = raw ? raw.model : node.model;

  const set = (change: EvaluatorChange) => apply({ type: "set_evaluator", at: node.ref, ...change });

  const rename = () => {
    const next = name.trim();
    if (next === "" || next === node.evaluator) return;
    // A built-in question belongs to its name. Under a name that has none, write it out, so there is still one to ask.
    const keep = written === null && !catalog.presets.some((candidate) => candidate.name === next);
    if (set({ id: next, ...(keep && { question }) })) {
      onSelectNode(evaluatorId(node.ref.category, node.ref.index, next));
    }
  };

  const [defaultModel] = runner.models;
  const models = [
    { value: "", label: defaultModel === undefined ? text.modelDefault : text.modelDefaultIs(defaultModel) },
    ...runner.models.map((value) => ({ value, label: value })),
    // A model the policy names that no connected runner offers is still what the policy says.
    ...(model !== null && !runner.models.includes(model) ? [{ value: model, label: model }] : []),
  ];

  return (
    <div className="wl-inspector">
      <header>
        <p className="ui-eyebrow">
          {copy.canvas.evaluator}
          {written === null ? <> · {text.builtIn}</> : null}
        </p>
        <h2 className="wl-heading wl-code">{node.evaluator}</h2>
        <p className="wl-muted">{text.body}</p>
      </header>
      <Problems errors={node.errors} />
      <form
        className="wl-row"
        onSubmit={(event) => {
          event.preventDefault();
          rename();
        }}
      >
        <Field label={text.name}>
          <Input
            className="wl-code"
            value={name}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={name.trim() === "" || name.trim() === node.evaluator}>
          {text.rename}
        </Button>
      </form>
      <QuestionField
        value={question}
        placeholders={catalog.placeholders}
        onChange={(next) => set({ question: next })}
      />
      {preset && written !== null ? (
        <div>
          <Button size="sm" onClick={() => set({ question: null })}>
            {text.useBuiltIn}
          </Button>
        </div>
      ) : null}
      <ConfidenceField value={minConfidence} onCommit={(next) => set({ minConfidence: next })} />
      <Field label={text.model} hint={runner.online ? undefined : text.modelOffline}>
        <Select
          aria-label={text.model}
          value={model ?? ""}
          options={models}
          onValueChange={(value) => set({ model: value === "" ? null : value })}
        />
      </Field>
      <section className="wl-section">
        <h3 className="ui-eyebrow">{text.given}</h3>
        <dl className="wl-facts">
          <dt>{text.sees}</dt>
          <dd>{text.seesBody}</dd>
          <dt>{text.never}</dt>
          <dd>{text.neverBody}</dd>
        </dl>
      </section>
      <Runs
        node={node}
        pulls={props.pulls}
        runner={runner}
        valid={props.valid}
        running={props.running}
        selectedPull={props.selectedPull}
        onSelectPull={props.onSelectPull}
        onRun={props.onRun}
      />
      <div>
        <Button
          variant="danger"
          onClick={() => {
            if (apply({ type: "remove_evaluator", at: node.ref })) onSelectNode(null);
          }}
        >
          {text.remove}
        </Button>
      </div>
    </div>
  );
}

/** The evaluators a lane can take: a built-in question by name, or one written here. */
export function AddEvaluator({
  category,
  graph,
  catalog,
  apply,
  onSelectNode,
}: {
  category: string;
  graph: FlowGraph;
  catalog: EvaluatorCatalog;
  apply: Apply;
  onSelectNode: (id: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [question, setQuestion] = useState("");
  const ready = EVALUATOR_NAME.test(name.trim()) && question.trim() !== "";

  // An evaluator goes at the end of the lane's, after its gates and before its outcome.
  const add = (id: string, asks?: string) => {
    const index = graph.nodes.filter((node) => node.kind === "evaluator" && node.ref.category === category).length;
    const edit: PolicyEdit = {
      type: "add_evaluator",
      category,
      id,
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      ...(asks !== undefined && { question: asks }),
    };
    if (apply(edit)) onSelectNode(evaluatorId(category, index, id));
  };

  return (
    <>
      <div className="wl-gate-choices">
        {catalog.presets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            className="wl-gate-choice wl-evaluator-choice"
            // Added without a question, so it asks the built-in one for its name.
            onClick={() => add(preset.name)}
          >
            <span className="wl-gate-choice-name">{preset.name}</span>
            <span className="wl-gate-choice-detail">{preset.description}</span>
            <span className="wl-node-tag">{copy.inspector.add.builtIn(formatConfidence(DEFAULT_MIN_CONFIDENCE))}</span>
          </button>
        ))}
      </div>
      <form
        className="wl-section"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) add(name.trim(), question.trim());
        }}
      >
        <h3 className="ui-eyebrow">{copy.inspector.add.own}</h3>
        <Field label={copy.inspector.add.ownName} hint={copy.inspector.add.ownNameHint}>
          <Input
            className="wl-code"
            value={name}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={copy.inspector.add.ownQuestion} hint={<QuestionHint placeholders={catalog.placeholders} />}>
          <Textarea
            className="wl-question"
            value={question}
            rows={5}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" variant="primary" disabled={!ready}>
            {copy.inspector.add.ownAdd}
          </Button>
        </div>
      </form>
    </>
  );
}
