import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizePlot } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, many, number, numberList, objectList, string } from "./common";

const PlotView = lazy(() =>
  import("@kw/widgets/PlotView").then((m) => ({ default: m.PlotView })),
);

export const plotSpec: FenceSpec = {
  lang: "plot",
  aliases: ["chart-xy"],
  description:
    "An x–y plot: complexity curves, predicate curves for binary search on the answer, latency against load, convergence.",
  component: PlotView,
  required: ["series"],
  schema: {
    attributes: {
      series: {
        type: "array",
        items: "object",
        required: true,
        description:
          '`{id?, label?, points: [{x, y}, …], kind?: "line"|"area"|"scatter", color?, baseline?}`, or `{expr: "sin(x) + a", samples?, domain?}` for a curve from a formula.',
      },
      regions: objectList(
        'Shaded areas from a predicate: `{when: "y < x^2", label?, color?, opacity?, resolution?}`. `x` and `y` are in scope.',
      ),
      bind: {
        type: "object",
        description: "Values for the free names in an `expr` or a `when`, e.g. `{a: 2}`. Steppable, so a walkthrough can sweep a parameter.",
      },
      shades: objectList("Shaded bands: `{from, to, series?, fromY?, toY?, color?, label?}`."),
      guides: objectList("Reference lines: `{x?, y?, label?, color?}` — an SLO, a threshold, a crossover."),
      marks: objectList("Single annotated points: `{x, y?, label?, color?}`."),
      activeIds: many("Series ids drawn in the active color."),
      highlightIds: many("Secondary-highlighted series ids."),
      dimIds: many("Dimmed series ids."),
      xMin: number("Left edge of the x axis. Defaults to the data extent."),
      xMax: number("Right edge of the x axis."),
      yMin: number("Bottom of the y axis."),
      yMax: number("Top of the y axis."),
      xTicks: numberList("Explicit x tick values."),
      yTicks: numberList("Explicit y tick values."),
      xLabel: string("Caption under the x axis.", false),
      yLabel: string("Caption beside the y axis.", false),
      showAxes: bool("Draw the axes and frame. Default true.", false),
      showLegend: bool("Draw the legend. Default true.", false),
      width: number("Canvas width, px.", false),
      height: number("Canvas height, px.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizePlot(props as Parameters<typeof summarizePlot>[0]),
  example: `\`\`\`plot id=predicate caption="Binary search on the answer: the predicate flips once"
xLabel: capacity
yLabel: days needed
series:
  - label: days(capacity)
    points: [{x: 10, y: 15}, {x: 15, y: 10}, {x: 20, y: 7}, {x: 25, y: 6}, {x: 30, y: 5}]
guides:
  - {y: 7, label: "budget"}
steps:
  - note: "Too slow: 15 days exceeds the 7-day budget"
    marks: [{x: 10, y: 15, label: "lo"}]
  - note: "Fast enough — search left for a smaller capacity"
    marks: [{x: 20, y: 7, label: "mid"}]
  - note: "The smallest capacity that fits the budget is 20"
    marks: [{x: 20, y: 7, label: "answer"}]
    breakpoint: true
\`\`\``,
};
