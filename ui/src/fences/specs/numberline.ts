import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeNumberLine } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, enumOf, many, number, numberList, objectList, string } from "./common";

const NumberLineView = lazy(() =>
  import("@kw/widgets/NumberLineView").then((m) => ({ default: m.NumberLineView })),
);

export const numberlineSpec: FenceSpec = {
  lang: "numberline",
  aliases: ["number-line", "kiwi-number-line"],
  description:
    "A single value axis: inequalities, interval arithmetic, binary-search-on-answer buckets, SLO thresholds. Closed endpoints are filled, open ones hollow.",
  component: NumberLineView,
  required: ["min", "max"],
  schema: {
    attributes: {
      min: { type: "number", required: true, description: "Left end of the axis.", steppable: false },
      max: { type: "number", required: true, description: "Right end of the axis.", steppable: false },
      step: number("Tick spacing. Omit for automatic nice ticks.", false),
      ticks: numberList("Explicit tick values, overriding `step`."),
      includeNumbers: bool("Print the number under each tick. Default true.", false),
      scale: enumOf(["linear", "log"], 'Axis scale. `"log"` needs a positive `min`.', false),
      points: objectList('`{x, label?, style?: "closed"|"open"|"cross", color?, id?}`.'),
      intervals: objectList("`{from, to, fromOpen?, toOpen?, label?, color?, row?}`. Overlapping intervals stack."),
      rays: objectList('`{at, dir: "left"|"right", open?, label?}` — an inequality with no far end.'),
      marks: objectList("Dashed reference lines: `{at, label?, color?}`."),
      pointers: objectList("Named pointers above the axis: `{at, label, color?}` — `lo`, `hi`, `mid`."),
      sweep: number("Position of a sweep cursor."),
      sweepLabel: string("Caption beside the sweep cursor."),
      activeIds: many("Ids drawn in the active color."),
      highlightIds: many("Secondary-highlighted ids."),
      dimIds: many("Dimmed ids."),
      label: string("Axis caption.", false),
      width: number("Canvas width, px.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeNumberLine(props as Parameters<typeof summarizeNumberLine>[0]),
  example: `\`\`\`numberline id=bsearch caption="Binary search on the answer: narrowing [1, 32]"
min: 0
max: 32
step: 4
label: capacity
steps:
  - note: "The whole range is still feasible"
    intervals: [{from: 1, to: 32, label: "candidates"}]
    pointers: [{at: 1, label: lo}, {at: 32, label: hi}, {at: 16, label: mid}]
  - note: "16 works — discard everything above it"
    intervals: [{from: 1, to: 16, label: "candidates", toOpen: false}]
    pointers: [{at: 1, label: lo}, {at: 16, label: hi}, {at: 8, label: mid}]
  - note: "8 is too small — the answer is in (8, 16]"
    intervals: [{from: 8, to: 16, fromOpen: true, label: "candidates"}]
    pointers: [{at: 9, label: lo}, {at: 16, label: hi}]
\`\`\``,
};
