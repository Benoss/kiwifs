import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeTimeline } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, many, number, numberList, objectList, string, stringList } from "./common";

const TimelineView = lazy(() =>
  import("@kw/widgets/TimelineView").then((m) => ({ default: m.TimelineView })),
);

export const timelineSpec: FenceSpec = {
  lang: "timeline",
  aliases: ["gantt", "schedule"],
  description:
    "Spans on a shared axis with named lanes and causal arrows: scheduling, lock handoffs, happens-before, isolation anomalies, log spans.",
  component: TimelineView,
  required: ["intervals"],
  schema: {
    attributes: {
      intervals: {
        type: "array",
        items: "object",
        required: true,
        description:
          '`{start, end, id?, label?, lane?, state?, color?}`. `start === end` draws a point event. `state` of "blocked" or "waiting" draws hatched.',
      },
      lanes: stringList("Named lanes in draw order, labelled in the gutter — `thread A` above `thread B`."),
      links: objectList("Causal arrows between spans: `{from, to, label?, dashed?}` — happens-before, woken by, lock handoff."),
      hoverPredecessors: bool("Hovering a span lights the happens-before cone behind it.", false),
      showLegend: bool("Draw a legend for the `state` values in use.", false),
      sweep: number("Position of the sweep cursor."),
      sweepLabel: string("Caption beside the sweep cursor — usually the running counter."),
      marks: objectList("Extra vertical marks: query points, event coordinates. `{at, label?, color?}`."),
      activeIds: many("Span ids active this step."),
      highlightIds: many("Secondary-highlighted span ids."),
      dimIds: many("Dimmed span ids."),
      min: number("Left end of the axis. Defaults to the data extent."),
      max: number("Right end of the axis."),
      ticks: numberList("Values to label on the axis."),
      showAxis: bool("Draw the axis. Default true.", false),
      width: number("Canvas width, px.", false),
      laneHeight: number("Row height, px. Default 26.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeTimeline(props as Parameters<typeof summarizeTimeline>[0]),
  example: `\`\`\`timeline id=lock caption="T2 blocks on the row lock T1 holds"
lanes: [T1, T2]
hoverPredecessors: true
intervals:
  - {id: t1run, lane: T1, start: 0, end: 4, label: "UPDATE", state: holding}
  - {id: t1commit, lane: T1, start: 4, end: 5, label: COMMIT, state: running}
  - {id: t2wait, lane: T2, start: 2, end: 5, label: "waiting for lock", state: blocked}
  - {id: t2run, lane: T2, start: 5, end: 8, label: "UPDATE", state: holding}
links:
  - {from: t1commit, to: t2run, label: "lock released"}
steps:
  - note: "T1 takes the row lock"
    activeIds: [t1run]
  - note: "T2's UPDATE blocks — hatched, because it is doing no work"
    activeIds: [t2wait]
  - note: "T1 commits and T2 is woken"
    activeIds: [t1commit, t2run]
\`\`\``,
};
