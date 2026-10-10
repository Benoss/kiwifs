import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizePlane } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, enumOf, many, number, numberList, objectList, string } from "./common";

const PlaneView = lazy(() =>
  import("@kw/widgets/PlaneView").then((m) => ({ default: m.PlaneView })),
);

export const planeSpec: FenceSpec = {
  lang: "plane",
  aliases: ["geometry"],
  description:
    "A coordinate plane in data units: geometry, sweep lines, hulls, vectors, tile maps. Draws what it is given — the algorithm stays in the steps.",
  component: PlaneView,
  required: ["points", "segments", "polygons", "circles", "vectors"],
  schema: {
    attributes: {
      xMin: number("Left edge. Default 0.", false),
      xMax: number("Right edge. Default 10.", false),
      yMin: number("Bottom edge. Default 0.", false),
      yMax: number("Top edge. Default 10.", false),
      xRange: numberList("`[min, max]`, an alias for xMin/xMax."),
      yRange: numberList("`[min, max]`, an alias for yMin/yMax."),
      grid: bool("Draw the unit grid. Default true.", false),
      axes: bool("Draw the axes through the origin. Default true.", false),
      aspect: enumOf(["equal", "auto"], '"equal" (default) keeps circles round and right angles right.', false),
      points: objectList('`{x, y, id?, label?, style?: "dot"|"open"|"cross"|"square", color?}`.'),
      segments: objectList("`{from, to, label?, arrow?, dashed?}`. Each end is a point id or a literal `[x, y]`."),
      polygons: objectList("`{points: [...], label?, open?, fill?}` — a triangle, a hull being built."),
      circles: objectList("`{at, r, label?, dashed?}`."),
      vectors: objectList("`{to, from?, label?}`. `from` defaults to the origin."),
      labels: objectList("Free text at a position: `{at, text, dx?, dy?}`."),
      sweep: { type: "object", description: '`{axis: "x"|"y"|"angle", at, origin?, label?}`.' },
      activeIds: many("Ids drawn in the active color."),
      highlightIds: many("Secondary-highlighted ids."),
      dimIds: many("Dimmed ids."),
      xLabel: string("Caption under the x axis.", false),
      yLabel: string("Caption beside the y axis.", false),
      width: number("Canvas width, px.", false),
      height: number("Canvas height, px.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizePlane(props as Parameters<typeof summarizePlane>[0]),
  example: `\`\`\`plane id=hull caption="Andrew's monotone chain, lower hull"
xMin: 0
xMax: 10
yMin: 0
yMax: 8
points:
  - {id: a, x: 1, y: 1, label: a}
  - {id: b, x: 3, y: 4, label: b}
  - {id: c, x: 5, y: 2, label: c}
  - {id: d, x: 8, y: 6, label: d}
  - {id: e, x: 9, y: 2, label: e}
steps:
  - note: "Sort by x, start the lower hull with a and b"
    polygons: [{points: [a, b], open: true, id: hull}]
    activeIds: [a, b]
  - note: "a→b→c turns clockwise, so b is not on the hull — pop it"
    polygons: [{points: [a, b, c], open: true, id: hull}]
    activeIds: [b]
  - note: "Lower hull is a, c, e"
    polygons: [{points: [a, c, e], open: true, id: hull}]
    highlightIds: [hull]
    dimIds: [b, d]
\`\`\``,
};
