import { ROUTER_NODE, type FlowGraph, type FlowNode } from "../../src/graph";

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 76;
const START_HEIGHT = 52;
const TRUNK_GAP = 22;
/** Room above the router for the "+" that adds an always-gate. */
const ROUTER_LEAD = 40;
/** Room right of the router for the comb of edges and the category names on them. */
export const ROUTER_GAP = 190;
const COLUMN_GAP = 44;
const ROW_GAP = 18;

const COLUMN = NODE_WIDTH + COLUMN_GAP;
const ROW = NODE_HEIGHT + ROW_GAP;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  boxes: Record<string, Box>;
  /** Which gate list a "+" on this edge adds to: a category name, or null for the always-gates. */
  addOn: Record<string, string | null>;
}

function heightOf(node: FlowNode): number {
  return node.kind === "start" ? START_HEIGHT : NODE_HEIGHT;
}

/**
 * Places the flowchart to fit a window that is taller than the policy is long:
 * the trunk runs down the left, since every pull request walks all of it; the
 * router at its foot fans out to one row per category on the right, centred on
 * the router, with the fallback last; and every lane's outcome sits in the
 * same column, so the endings line up.
 */
export function layoutGraph(graph: FlowGraph): Layout {
  const boxes: Record<string, Box> = {};
  const addOn: Record<string, string | null> = {};

  let y = 0;
  for (const node of graph.nodes) {
    if (node.lane !== null || node.kind === "outcome") continue;
    if (node.id === ROUTER_NODE) y += ROUTER_LEAD - TRUNK_GAP;
    const height = heightOf(node);
    boxes[node.id] = { x: 0, y, width: NODE_WIDTH, height };
    y += height + TRUNK_GAP;
  }

  const router = boxes[ROUTER_NODE];
  const centre = router ? router.y + router.height / 2 : 0;
  const rows = graph.lanes.length + 1;
  const rowY = (row: number) => centre + (row - (rows - 1) / 2) * ROW - NODE_HEIGHT / 2;

  const lanesX = NODE_WIDTH + ROUTER_GAP;
  const inLane = (lane: string) => graph.nodes.filter((node) => node.lane === lane);
  const longest = Math.max(1, ...graph.lanes.map((lane) => inLane(lane).length));
  const endX = lanesX + (longest - 1) * COLUMN;

  graph.lanes.forEach((lane, row) => {
    inLane(lane).forEach((node, column) => {
      const x = node.kind === "outcome" ? endX : lanesX + column * COLUMN;
      boxes[node.id] = { x, y: rowY(row), width: NODE_WIDTH, height: NODE_HEIGHT };
    });
  });
  for (const node of graph.nodes) {
    if (node.kind === "outcome" && node.fallback) {
      boxes[node.id] = { x: endX, y: rowY(rows - 1), width: NODE_WIDTH, height: NODE_HEIGHT };
    }
  }

  // A gate is added at the end of its list, so the "+" goes on the edge into whatever follows the list:
  // the router for the always-gates, a lane's first evaluator or its outcome for a category's.
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const target = byId.get(edge.target);
    const source = byId.get(edge.source);
    if (!target || !source) continue;
    if (target.id === ROUTER_NODE) addOn[edge.id] = null;
    else if (target.lane !== null && target.kind !== "gate" && (source.kind === "gate" || source.id === ROUTER_NODE)) {
      addOn[edge.id] = target.lane;
    }
  }

  return { boxes, addOn };
}
