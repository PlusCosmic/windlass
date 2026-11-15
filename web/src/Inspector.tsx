import { Button, EmptyState, Field, Input, Notice, SegmentedControl, Select } from "@pluscosmic/ui";
import { useState } from "react";
import { laneEnd, type FlowGraph, type FlowNode } from "../../src/graph";
import { readGate, type PolicyEdit } from "../../src/policy/edit";
import type { EvaluatorCatalog, GateInfo, RunnerStatus, SimulatedPull } from "./api";
import { ArgsForm } from "./ArgsForm";
import type { AddTarget } from "./Canvas";
import { copy } from "./copy/app";
import { AddEvaluator, EvaluatorInspector } from "./EvaluatorInspector";
import { Problems } from "./Problems";
import { countOutcomes, undefinedCategories, type Replay } from "./trace";

type GateNode = Extract<FlowNode, { kind: "gate" }>;
type OutcomeNode = Extract<FlowNode, { kind: "outcome" }>;

interface InspectorProps {
  graph: FlowGraph;
  node: FlowNode | null;
  adding: AddTarget | null;
  source: string;
  gates: GateInfo[];
  /** The built-in questions an evaluator can ask, and what a question can refer to. */
  evaluators: EvaluatorCatalog;
  runner: RunnerStatus;
  replay: Replay;
  pulls: SimulatedPull[];
  selectedPull: number | null;
  /** Whether the draft is a valid policy. */
  valid: boolean;
  /** A request to run the evaluators is on its way. */
  running: boolean;
  /** Makes the change, reporting a failure itself. True when it was made. */
  apply: (edit: PolicyEdit) => boolean;
  onSelectNode: (id: string | null) => void;
  onSelectPull: (number: number) => void;
  onCancelAdd: () => void;
  /** Asks the runner about every stored pull request with no answer under the draft. */
  onRunEvaluators: () => void;
}

const FAIL_OUTCOMES = ["escalate", "block"] as const;
const OUTCOMES = ["merge", "escalate", "block"] as const;

/** The id the parser will give a gate at this place in the policy. */
function gateId(category: string | null, index: number, gate: string): string {
  return `${category ?? "always"}[${index}]:${gate}`;
}

function gateCount(graph: FlowGraph, category: string | null): number {
  return graph.nodes.filter((node) => node.kind === "gate" && node.ref.category === category).length;
}

/** The pull requests a node took off the merge path, as links that select them. */
function OffPath({ numbers, onSelectPull }: { numbers: number[]; onSelectPull: (number: number) => void }) {
  return (
    <section className="wl-section">
      <h3 className="ui-eyebrow">{copy.inspector.offPath}</h3>
      {numbers.length === 0 ? (
        <p className="wl-muted">{copy.inspector.offPathNone}</p>
      ) : (
        <div className="wl-pull-links">
          {numbers.map((number) => (
            <button key={number} type="button" className="wl-link" onClick={() => onSelectPull(number)}>
              #{number}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Summary({ pulls }: { pulls: SimulatedPull[] }) {
  if (pulls.length === 0) return <p className="wl-muted">{copy.inspector.summaryNone}</p>;
  const before = countOutcomes(pulls, "current");
  const after = countOutcomes(pulls, "draft");
  return (
    <table className="wl-summary">
      <thead>
        <tr>
          <th />
          <th>{copy.inspector.before}</th>
          <th>{copy.inspector.after}</th>
        </tr>
      </thead>
      <tbody>
        {(["merge", "escalate", "block", "pending"] as const).map((outcome) =>
          before[outcome] + after[outcome] === 0 && outcome === "pending" ? null : (
            <tr key={outcome} className={after[outcome] !== before[outcome] ? "wl-changed" : undefined}>
              <th>
                <span className={`wl-dot wl-tone-${outcome}`} />
                {copy.outcome[outcome]}
              </th>
              <td>{before[outcome]}</td>
              <td>{after[outcome]}</td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

/** What the "+" offers: a gate, or in a category's lane an evaluator to ask once its gates have passed. */
function AddNode({
  target,
  gates,
  evaluators,
  graph,
  apply,
  onSelectNode,
  onCancel,
}: {
  target: AddTarget;
  gates: GateInfo[];
  evaluators: EvaluatorCatalog;
  graph: FlowGraph;
  apply: InspectorProps["apply"];
  onSelectNode: InspectorProps["onSelectNode"];
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<"gate" | "evaluator">("gate");
  const { category } = target;
  const evaluator = category !== null && kind === "evaluator";

  return (
    <div className="wl-inspector">
      <header>
        <h2 className="wl-heading">{evaluator ? copy.inspector.add.evaluatorTitle : copy.inspector.add.title}</h2>
        <p className="wl-muted">
          {category === null
            ? copy.inspector.add.always
            : evaluator
              ? copy.inspector.add.evaluator(category)
              : copy.inspector.add.category(category)}
        </p>
      </header>
      {category !== null ? (
        <SegmentedControl
          className="wl-kind"
          aria-label={copy.inspector.add.kind.label}
          value={kind}
          options={[
            { value: "gate", label: copy.inspector.add.kind.gate },
            { value: "evaluator", label: copy.inspector.add.kind.evaluator },
          ]}
          onChange={setKind}
        />
      ) : null}
      {category !== null && evaluator ? (
        <AddEvaluator
          category={category}
          graph={graph}
          catalog={evaluators}
          apply={apply}
          onSelectNode={onSelectNode}
        />
      ) : (
        <div className="wl-gate-choices">
          {gates.map((gate) => (
            <button
              key={gate.name}
              type="button"
              className="wl-gate-choice"
              onClick={() => {
                const index = gateCount(graph, category);
                // Added without arguments: a gate that needs some shows what's missing, and the draft stays invalid until they're given.
                if (apply({ type: "add_gate", category, gate: gate.name })) {
                  onSelectNode(gateId(category, index, gate.name));
                }
              }}
            >
              <span className="wl-gate-choice-name">{gate.name}</span>
              <span className="wl-gate-choice-detail">{gate.description}</span>
              <span className={`wl-node-tag wl-tag-${gate.defaultOnFail}`}>
                {copy.inspector.add.defaultFail(gate.defaultOnFail)}
              </span>
            </button>
          ))}
        </div>
      )}
      <div>
        <Button variant="ghost" onClick={onCancel}>
          {copy.inspector.add.cancel}
        </Button>
      </div>
    </div>
  );
}

function GateInspector({ node, props }: { node: GateNode; props: InspectorProps }) {
  const { graph, source, gates, replay, apply, onSelectNode, onSelectPull } = props;
  const info = gates.find((gate) => gate.name === node.gate);
  // As written in the file, so arguments the parser rejected can still be seen and fixed.
  const raw = readGate(source, node.ref);
  const onFail = raw?.onFail === "escalate" || raw?.onFail === "block" ? raw.onFail : "default";
  const place = node.ref.category ?? "";

  return (
    <div className="wl-inspector">
      <header>
        <p className="ui-eyebrow">{copy.canvas.gate}</p>
        <h2 className="wl-heading wl-code">{node.gate}</h2>
        <p className="wl-muted">{node.description}</p>
      </header>
      <Problems errors={node.errors} />
      <ArgsForm
        key={node.id}
        schema={info?.args}
        value={raw?.args}
        onChange={(args) => apply({ type: "set_gate_args", at: node.ref, args })}
      />
      <Field label={copy.inspector.onFail.label} hint={copy.inspector.onFail.hint}>
        <SegmentedControl
          aria-label={copy.inspector.onFail.label}
          value={onFail}
          options={[
            { value: "default", label: copy.inspector.onFail.default(info?.defaultOnFail ?? "escalate") },
            ...FAIL_OUTCOMES.map((value) => ({ value, label: copy.outcome[value] })),
          ]}
          onChange={(value) => apply({ type: "set_on_fail", at: node.ref, onFail: value === "default" ? null : value })}
        />
      </Field>
      <Field label={copy.inspector.moveTo}>
        <Select
          aria-label={copy.inspector.moveTo}
          value={place}
          options={[
            { value: "", label: copy.inspector.always },
            ...graph.lanes.map((lane) => ({ value: lane, label: copy.inspector.inCategory(lane) })),
          ]}
          onValueChange={(value) => {
            const category = value === "" ? null : value;
            if (category === node.ref.category) return;
            const index = gateCount(graph, category);
            if (apply({ type: "move_gate", at: node.ref, to: { category, index } })) {
              onSelectNode(gateId(category, index, node.gate));
            }
          }}
        />
      </Field>
      <OffPath numbers={replay.nodes[node.id]?.off ?? []} onSelectPull={onSelectPull} />
      <div>
        <Button
          variant="danger"
          onClick={() => {
            if (apply({ type: "remove_gate", at: node.ref })) onSelectNode(null);
          }}
        >
          {copy.inspector.remove}
        </Button>
      </div>
    </div>
  );
}

function RouterInspector({ props }: { props: InspectorProps }) {
  const { graph, pulls, apply, onSelectNode } = props;
  const [name, setName] = useState("");
  const undefinedOnes = undefinedCategories(graph, pulls);
  const fallback = graph.nodes.find((node): node is OutcomeNode => node.kind === "outcome" && node.fallback);

  // Lanes for categories already being declared are added in a row, so the router stays selected;
  // a newly named one is opened, since its outcome is the next thing to decide.
  const addLane = (category: string, open: boolean) => {
    if (apply({ type: "add_category", name: category }) && open) onSelectNode(laneEnd(category));
  };

  return (
    <div className="wl-inspector">
      <header>
        <h2 className="wl-heading">{copy.canvas.router.title}</h2>
        <p className="wl-muted">{copy.inspector.router.body}</p>
      </header>
      {undefinedOnes.length > 0 ? (
        <section className="wl-section">
          <h3 className="ui-eyebrow">{copy.inspector.router.undefinedTitle}</h3>
          <p className="wl-muted">{copy.inspector.router.undefinedBody}</p>
          <ul className="wl-undefined">
            {undefinedOnes.map(([category, count]) => (
              <li key={category}>
                <span className="wl-code">{category}</span>
                <span className="wl-edge-count">{count}</span>
                <Button size="sm" onClick={() => addLane(category, false)}>
                  {copy.inspector.router.addLane}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <form
        className="wl-section"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "") return;
          addLane(name.trim(), true);
          setName("");
        }}
      >
        <Field label={copy.inspector.router.newCategory} hint={copy.inspector.router.newCategoryHint}>
          <Input
            className="wl-code"
            value={name}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" disabled={name.trim() === ""}>
            {copy.inspector.router.add}
          </Button>
        </div>
      </form>
      {fallback ? <FallbackField node={fallback} apply={apply} /> : null}
    </div>
  );
}

function FallbackField({ node, apply }: { node: OutcomeNode; apply: InspectorProps["apply"] }) {
  return (
    <Field label={copy.inspector.router.fallback}>
      <SegmentedControl
        aria-label={copy.inspector.router.fallback}
        value={node.outcome === "block" ? "block" : "escalate"}
        options={FAIL_OUTCOMES.map((value) => ({ value, label: copy.outcome[value] }))}
        onChange={(outcome) => apply({ type: "set_fallback", outcome })}
      />
    </Field>
  );
}

function LaneInspector({ node, props }: { node: OutcomeNode; props: InspectorProps }) {
  const { graph, apply, onSelectNode } = props;
  const category = node.lane ?? "";
  const [name, setName] = useState(category);
  const guarded = graph.nodes.some((other) => other.lane === category && other.kind !== "outcome");

  return (
    <div className="wl-inspector">
      <header>
        <p className="ui-eyebrow">{copy.inspector.lane.name}</p>
        <h2 className="wl-heading wl-code">{category}</h2>
      </header>
      <Problems errors={node.errors} />
      <Field label={copy.inspector.lane.outcome} hint={copy.inspector.lane.outcomeHint}>
        <SegmentedControl
          aria-label={copy.inspector.lane.outcome}
          value={node.outcome}
          options={OUTCOMES.map((value) => ({ value, label: copy.outcome[value] }))}
          onChange={(outcome) => apply({ type: "set_outcome", category, outcome })}
        />
      </Field>
      {node.outcome === "merge" && !guarded ? (
        <Notice tone="warning" compact>
          {copy.inspector.lane.mergeNoGates}
        </Notice>
      ) : null}
      <form
        className="wl-row"
        onSubmit={(event) => {
          event.preventDefault();
          const next = name.trim();
          if (next !== "" && next !== category && apply({ type: "rename_category", from: category, to: next })) {
            onSelectNode(laneEnd(next));
          }
        }}
      >
        <Field label={copy.inspector.lane.name}>
          <Input
            className="wl-code"
            value={name}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={name.trim() === "" || name.trim() === category}>
          {copy.inspector.lane.rename}
        </Button>
      </form>
      <div>
        <Button
          variant="danger"
          onClick={() => {
            if (apply({ type: "remove_category", name: category })) onSelectNode(null);
          }}
        >
          {copy.inspector.lane.remove}
        </Button>
      </div>
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const { node, adding, graph, gates, replay, pulls, apply, onSelectNode, onSelectPull, onCancelAdd } = props;

  if (adding) {
    return (
      <AddNode
        // Each "+" starts from the gates again.
        key={adding.category ?? ""}
        target={adding}
        gates={gates}
        evaluators={props.evaluators}
        graph={graph}
        apply={apply}
        onSelectNode={onSelectNode}
        onCancel={onCancelAdd}
      />
    );
  }

  if (!node || node.kind === "start") {
    return (
      <div className="wl-inspector">
        <section className="wl-section">
          <h3 className="ui-eyebrow">{copy.inspector.summaryTitle}</h3>
          <Summary pulls={pulls} />
        </section>
        <EmptyState title={copy.inspector.empty.title}>{copy.inspector.empty.body}</EmptyState>
      </div>
    );
  }

  switch (node.kind) {
    case "gate":
      return <GateInspector key={node.id} node={node} props={props} />;
    case "router":
      return <RouterInspector props={props} />;
    case "outcome":
      if (!node.fallback) return <LaneInspector key={node.id} node={node} props={props} />;
      return (
        <div className="wl-inspector">
          <header>
            <h2 className="wl-heading">{copy.inspector.fallbackEnd.title}</h2>
            <p className="wl-muted">{copy.inspector.fallbackEnd.body}</p>
          </header>
          <Problems errors={node.errors} />
          <FallbackField node={node} apply={apply} />
        </div>
      );
    case "builtin":
      return (
        <div className="wl-inspector">
          <header>
            <h2 className="wl-heading">{copy.canvas.builtin[node.check].title}</h2>
            <p className="wl-muted">{copy.inspector.builtin[node.check]}</p>
          </header>
          <p className="wl-muted">{copy.inspector.builtinFixed}</p>
          <OffPath numbers={replay.nodes[node.id]?.off ?? []} onSelectPull={onSelectPull} />
        </div>
      );
    case "evaluator":
      return (
        <EvaluatorInspector
          key={node.id}
          node={node}
          source={props.source}
          catalog={props.evaluators}
          runner={props.runner}
          pulls={pulls}
          selectedPull={props.selectedPull}
          valid={props.valid}
          running={props.running}
          apply={apply}
          onSelectNode={onSelectNode}
          onSelectPull={onSelectPull}
          onRun={props.onRunEvaluators}
        />
      );
  }
}
