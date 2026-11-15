import { IconAlertTriangle, IconPlus } from "@tabler/icons-react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { cx, useAppearance } from "@pluscosmic/ui";
import { memo, useEffect, useMemo } from "react";
import { ROUTER_NODE, type FlowGraph, type FlowNode, type Trace, type TraceStatus } from "../../src/graph";
import { copy } from "./copy/app";
import { formatConfidence } from "./evaluators";
import { layoutGraph } from "./layout";
import type { NodeTally, Replay } from "./trace";

/** What the "+" on an edge adds to: a category's gates and evaluators, or the always-gates (null). */
export type AddTarget = { category: string | null };

interface CanvasProps {
  graph: FlowGraph;
  replay: Replay;
  /** The selected pull request's path; null when none is selected. */
  trace: Trace | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (target: AddTarget) => void;
}

type NodeData = {
  node: FlowNode;
  width: number;
  height: number;
  status: TraceStatus | null;
  /** A pull request is selected and never reached this node. */
  dimmed: boolean;
  tally: NodeTally | null;
  selected: boolean;
};

type EdgeData = {
  label: string | null;
  count: number | null;
  active: boolean;
  dimmed: boolean;
  add: AddTarget | null;
  onAdd: (target: AddTarget) => void;
};

type CanvasNode = Node<NodeData, "policy">;
type CanvasEdge = Edge<EdgeData, "flow">;

function summarize(args: unknown): string {
  if (args === undefined || args === null) return copy.canvas.noArgs;
  if (Array.isArray(args)) return args.join(", ");
  if (typeof args === "object") {
    const parts = Object.entries(args).map(
      ([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
    );
    return parts.length > 0 ? parts.join(" · ") : copy.canvas.noArgs;
  }
  return String(args);
}

const PolicyNode = memo(function PolicyNode({ data }: NodeProps<CanvasNode>) {
  const { node, width, height, status, dimmed, tally, selected } = data;
  // The trunk runs down the page; the router turns the flow to the right, along the lanes.
  const inTrunk = node.lane === null && node.kind !== "outcome";
  const off = tally?.off.length ?? 0;
  const notRun = tally?.notRun ?? 0;

  let eyebrow: string | null = null;
  let title: string;
  let detail: string | null = null;
  let tag: { text: string; tone: string } | null = null;
  let tone: string | null = null;

  switch (node.kind) {
    case "start":
      title = copy.canvas.start;
      detail = copy.canvas.startHint;
      break;
    case "builtin":
      title = copy.canvas.builtin[node.check].title;
      detail = copy.canvas.builtin[node.check].hint;
      tag = { text: copy.canvas.builtinFail, tone: "escalate" };
      break;
    case "gate":
      eyebrow = copy.canvas.gate;
      title = node.gate;
      detail = summarize(node.args);
      tag = { text: copy.canvas.onFail(node.onFail), tone: node.onFail };
      break;
    case "router":
      title = copy.canvas.router.title;
      detail = copy.canvas.router.hint;
      break;
    case "evaluator":
      eyebrow = copy.canvas.evaluator;
      title = node.evaluator;
      detail = copy.canvas.evaluatorDetail(formatConfidence(node.minConfidence));
      tag = { text: copy.canvas.evaluatorFail, tone: "escalate" };
      break;
    case "outcome":
      title = copy.outcome[node.outcome];
      detail = node.fallback ? copy.canvas.fallbackTitle : copy.canvas.laneEnd(node.lane ?? "");
      tone = node.outcome;
      break;
  }

  return (
    <div
      className={cx(
        "wl-node",
        `wl-node-${node.kind}`,
        tone && `wl-tone-${tone}`,
        status && `wl-status-${status}`,
        // A failed node takes the colour of what its failure contributes.
        status === "fail" && node.kind === "gate" && `wl-fail-${node.onFail}`,
        dimmed && "wl-dimmed",
        selected && "wl-selected",
        node.errors.length > 0 && "wl-invalid",
      )}
      style={{ width, height }}
    >
      {node.kind !== "start" ? (
        <Handle type="target" position={inTrunk ? Position.Top : Position.Left} isConnectable={false} />
      ) : null}
      <div className="wl-node-head">
        {eyebrow ? <span className="wl-node-eyebrow">{eyebrow}</span> : null}
        {status ? <span className="wl-node-status">{copy.canvas.status[status]}</span> : null}
        {!status && off > 0 ? (
          <span className="wl-node-count" title={copy.canvas.failing(off)}>
            {copy.canvas.count(off)}
          </span>
        ) : !status && notRun > 0 ? (
          <span className="wl-node-count wl-node-count-idle" title={copy.canvas.notRunHint(notRun)}>
            {copy.canvas.notRun(notRun)}
          </span>
        ) : null}
      </div>
      <div className="wl-node-title">{title}</div>
      {detail ? <div className="wl-node-detail">{detail}</div> : null}
      {node.errors.length > 0 ? (
        <div className="wl-node-tag wl-tag-invalid">
          <IconAlertTriangle size={12} aria-hidden="true" />
          {copy.canvas.problems(node.errors.length)}
        </div>
      ) : tag ? (
        <div className={cx("wl-node-tag", `wl-tag-${tag.tone}`)}>{tag.text}</div>
      ) : null}
      {node.kind !== "outcome" ? (
        <Handle
          type="source"
          position={inTrunk && node.kind !== "router" ? Position.Bottom : Position.Right}
          isConnectable={false}
        />
      ) : null}
    </div>
  );
});

/** How far right of the router its edges turn towards their rows. */
const COMB = 22;

/**
 * Straight down the trunk and straight along a lane. From the router: out, up or down to the target's row,
 * then along it, so its edges fan out in a tidy comb.
 */
function elbow(sx: number, sy: number, tx: number, ty: number): string {
  if (Math.abs(sx - tx) < 1) return `M ${sx} ${sy} V ${ty}`;
  if (Math.abs(sy - ty) < 1) return `M ${sx} ${sy} H ${tx}`;
  const bend = sx + COMB;
  const radius = Math.min(10, Math.abs(ty - sy) / 2);
  const down = ty > sy ? 1 : -1;
  return [
    `M ${sx} ${sy}`,
    `H ${bend - radius}`,
    `Q ${bend} ${sy} ${bend} ${sy + down * radius}`,
    `V ${ty - down * radius}`,
    `Q ${bend} ${ty} ${bend + radius} ${ty}`,
    `H ${tx}`,
  ].join(" ");
}

const FlowEdgeView = memo(function FlowEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  source,
}: EdgeProps<CanvasEdge>) {
  if (!data) return null;
  const fromRouter = source === ROUTER_NODE;
  const vertical = Math.abs(sourceX - targetX) < 1;
  // The category's name sits on the edge's last stretch, just past the comb. The "+" sits just before the node
  // that follows the gate list, wherever that node is.
  const labelX = sourceX + COMB + 10;
  const add = vertical ? { x: targetX, y: targetY - 20 } : { x: targetX - 22, y: targetY };

  return (
    <>
      <BaseEdge
        path={elbow(sourceX, sourceY, targetX, targetY)}
        className={cx("wl-edge", data.active && "wl-edge-active", data.dimmed && "wl-edge-dimmed")}
      />
      <EdgeLabelRenderer>
        {fromRouter ? (
          <div
            className={cx("wl-edge-label", data.active && "wl-edge-label-active", data.dimmed && "wl-dimmed")}
            style={{ transform: `translate(0, -50%) translate(${labelX}px, ${targetY}px)` }}
          >
            <span className="wl-edge-name">{data.label ?? copy.canvas.fallback}</span>
            {data.count !== null && data.count > 0 ? <span className="wl-edge-count">{data.count}</span> : null}
          </div>
        ) : null}
        {data.add ? (
          <button
            type="button"
            className="wl-add nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${add.x}px, ${add.y}px)` }}
            aria-label={data.add.category === null ? copy.canvas.addAlways : copy.canvas.addTo(data.add.category)}
            title={data.add.category === null ? copy.canvas.addGate : copy.canvas.addNode}
            onClick={() => data.add && data.onAdd(data.add)}
          >
            <IconPlus size={13} aria-hidden="true" />
          </button>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
});

const nodeTypes = { policy: PolicyNode };
/** Fit the whole policy, but never blow a small one up past its natural size. */
const FIT = { padding: 0.06, maxZoom: 1 };
const edgeTypes = { flow: FlowEdgeView };

function Flow({ graph, replay, trace, selected, onSelect, onAdd }: CanvasProps) {
  const { theme } = useAppearance();
  const { fitView } = useReactFlow();
  const layout = useMemo(() => layoutGraph(graph), [graph]);

  const nodes = useMemo<CanvasNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "policy",
        position: { x: layout.boxes[node.id]?.x ?? 0, y: layout.boxes[node.id]?.y ?? 0 },
        data: {
          node,
          width: layout.boxes[node.id]?.width ?? 0,
          height: layout.boxes[node.id]?.height ?? 0,
          status: trace?.nodes[node.id] ?? null,
          dimmed: trace !== null && !(node.id in trace.nodes),
          tally: replay.nodes[node.id] ?? null,
          selected: selected === node.id,
        },
        draggable: false,
        connectable: false,
        // Selection is ours: one node at a time, kept in the editor's state.
        selectable: false,
      })),
    [graph, layout, trace, replay, selected],
  );

  const edges = useMemo<CanvasEdge[]>(
    () =>
      graph.edges.map((edge) => {
        const add = edge.id in layout.addOn ? { category: layout.addOn[edge.id] ?? null } : null;
        const active = trace?.edges.includes(edge.id) ?? false;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "flow",
          focusable: false,
          selectable: false,
          zIndex: active ? 1 : 0,
          data: {
            label: edge.label ?? null,
            count: trace === null && edge.source === ROUTER_NODE ? (replay.edges[edge.id] ?? 0) : null,
            active,
            dimmed: trace !== null && !active,
            add,
            onAdd,
          },
        };
      }),
    [graph, layout, trace, replay, onAdd],
  );

  // Refit when the policy's shape changes (a lane or gate added), not when a selection does.
  const shape = `${graph.nodes.length}:${graph.lanes.join(",")}`;
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView({ ...FIT, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [shape, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      fitView
      fitViewOptions={FIT}
      minZoom={0.2}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
