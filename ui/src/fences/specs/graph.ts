import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeGraph } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, enumOf, many, number, objectList, string } from "./common";

const GraphView = lazy(() =>
  import("@kw/widgets/GraphView").then((m) => ({ default: m.GraphView })),
);

export const graphSpec: FenceSpec = {
  lang: "graph",
  description:
    "Nodes and edges: algorithm graphs, service architecture, state machines, dependency DAGs. Edge keys are `\"from->to\"` or an explicit `id`.",
  component: GraphView,
  required: ["nodes"],
  schema: {
    attributes: {
      nodes: {
        type: "array",
        items: "object",
        required: true,
        description:
          "`{id, label?, sublabel?, shape?, x?, y?, color?, group?}`. Omit x/y to have the layout place the node.",
      },
      edges: objectList("`{from, to, weight?, label?, id?, style?, color?, animated?, bidirectional?}`."),
      activeNodes: many("Node ids active this step."),
      highlightNodes: many("Secondary-highlighted node ids."),
      dimNodes: many("Dimmed node ids."),
      activeEdges: many('Edge keys (`"from->to"` or `id`) active this step.'),
      highlightEdges: many("Secondary-highlighted edge keys."),
      dimEdges: many("Dimmed edge keys."),
      directed: bool("Draw arrowheads. Default false.", false),
      pointers: objectList("Labels beside nodes: `{id, label, color?}`."),
      layout: enumOf(
        ["force", "layered", "circular", "grid", "dagre"],
        'Placement for nodes without x/y. "dagre" for architecture and flow diagrams, "layered" for DAGs and trees, "circular" for small dense graphs.',
        false,
      ),
      flow: enumOf(["down", "up"], 'Layered layout: "up" draws edge targets on top (child → parent pointers).', false),
      direction: enumOf(["TB", "BT", "LR", "RL"], "Dagre rank direction. Default TB.", false),
      nodeSpacing: number("Dagre: gap between nodes in a rank, px. Default 36.", false),
      rankSpacing: number("Dagre: gap between ranks, px. Default 52.", false),
      shape: string("Default node outline: circle, box, person, cylinder, queue, pill, cloud, …", false),
      groups: objectList("Labelled containers behind their members: `{id, label?, nodes?, parent?, color?}`."),
      packets: objectList("Dots travelling along edges: `{edge, t?, label?, reverse?}`."),
      packetDuration: number("How long an untimed packet takes to cross its edge, ms. Default 900.", false),
      nodeColors: { type: "object", description: "Base color per node id." },
      edgeColors: { type: "object", description: "Base color per edge key — tree vs back edges in a DFS." },
      badges: { type: "object", description: "Small value at each node's corner: distance, degree, rank." },
      animate: bool("Glide nodes to new positions between steps. Default true.", false),
      zoomable: bool("Wrap in a zoom / pan viewport.", false),
      nodeSize: number("Node diameter in px. Default 36.", false),
      width: number("Canvas width in px.", false),
      height: number("Canvas height in px.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeGraph(props as Parameters<typeof summarizeGraph>[0]),
  example: `\`\`\`graph id=bfs layout=layered caption="BFS from A"
directed: true
nodes:
  - {id: A}
  - {id: B}
  - {id: C}
  - {id: D}
edges:
  - {from: A, to: B}
  - {from: A, to: C}
  - {from: B, to: D}
  - {from: C, to: D}
badges: {A: 0}
steps:
  - note: "Start at A, distance 0"
    activeNodes: [A]
  - note: "Visit A's neighbours at distance 1"
    activeNodes: [B, C]
    dimNodes: [A]
    activeEdges: ["A->B", "A->C"]
    badges: {A: 0, B: 1, C: 1}
  - note: "D is reached at distance 2"
    activeNodes: [D]
    dimNodes: [A, B, C]
    activeEdges: ["B->D"]
    badges: {A: 0, B: 1, C: 1, D: 2}
\`\`\``,
};
