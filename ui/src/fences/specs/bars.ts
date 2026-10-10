import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeBars } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, many, number, objectList } from "./common";

const BarView = lazy(() =>
  import("@kw/widgets/BarView").then((m) => ({ default: m.BarView })),
);

export const barsSpec: FenceSpec = {
  lang: "bars",
  aliases: ["histogram", "barchart"],
  description:
    "Columns in value space: histograms, trapping rain water, largest rectangle, sorting passes, latency distributions.",
  component: BarView,
  required: ["values"],
  schema: {
    attributes: {
      values: {
        type: "array",
        items: "number",
        required: true,
        description: "Bar heights. Negatives draw below a zero baseline.",
      },
      labels: { type: "array", description: "Labels under each bar. Defaults to the index; `null` hides one." },
      valueLabels: {
        type: ["boolean", "array"],
        description: "Value labels on the bar tips: true (default), false, or custom text per bar.",
      },
      activeIndices: many("Emphasised columns."),
      highlightIndices: many("Secondary-highlighted columns."),
      dimIndices: many("Dimmed or eliminated columns."),
      barColors: { type: "array", description: "Per-bar fill override." },
      pointers: objectList("Named pointers above columns: `{index, label, color?}`."),
      overlays: objectList("Value-space rectangles: `{startIndex, endIndex?, fromValue?, toValue, label?}` — a water fill, a chosen rectangle."),
      guides: objectList("Horizontal reference lines: `{value, label?, color?}` — a water level, an SLO."),
      maxValue: number("Top of the value axis."),
      minValue: number("Bottom of the value axis."),
      chartHeight: number("Plot height, px. Default 220.", false),
      barWidth: number("Bar width, px. Default 40.", false),
      gap: number("Gap between bars, px. Default 10.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeBars(props as Parameters<typeof summarizeBars>[0]),
  example: `\`\`\`bars id=rain caption="Trapping rain water"
values: [0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 2, 1]
steps:
  - note: "Water sits wherever both sides are higher"
    overlays: [{startIndex: 2, toValue: 1, label: "1"}]
    activeIndices: [1, 3]
  - note: "The big basin between 3 and 7 holds four units"
    overlays:
      - {startIndex: 2, toValue: 1}
      - {startIndex: 4, endIndex: 6, toValue: 2, label: "4"}
    activeIndices: [3, 7]
  - note: "Total: 6"
    overlays:
      - {startIndex: 2, toValue: 1}
      - {startIndex: 4, endIndex: 6, toValue: 2}
      - {startIndex: 9, toValue: 2, label: "1"}
\`\`\``,
};
