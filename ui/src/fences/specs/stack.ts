import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeStack } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, enumOf, many, number, objectList, string } from "./common";

const StackView = lazy(() =>
  import("@kw/widgets/StackView").then((m) => ({ default: m.StackView })),
);

export const stackSpec: FenceSpec = {
  lang: "stack",
  description:
    "A LIFO stack: monotonic stacks, bracket matching, call stacks, undo histories.",
  component: StackView,
  required: ["values"],
  schema: {
    attributes: {
      values: {
        type: ["array", "string"],
        required: true,
        description: "Items from the bottom of the stack to the top.",
      },
      activeIndex: number("Index of the active item. Defaults to the top."),
      highlightIndices: many("Secondary-highlighted indices."),
      dimIndices: many("Dimmed indices."),
      pointers: objectList("Markers beside items: `{index, label, color?}`."),
      growth: enumOf(["top", "bottom"], "Which end the top of the stack is drawn at. Default top.", false),
      topLabel: string('Caption on the open end. Default "top".', false),
      showIndices: bool("Show the index of each item. Default true.", false),
      maxHeight: number("Scroll past this height, px. Default 300.", false),
      itemWidth: number("Item width, px.", false),
      itemHeight: number("Item height, px.", false),
      title: string("Caption above the stack.", false),
      empty: string('Text shown when there are no items. Default "(empty)".', false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeStack(props as Parameters<typeof summarizeStack>[0]),
  example: `\`\`\`stack id=monotonic title=stack caption="Next greater element"
values: []
steps:
  - note: "Push 2"
    values: [2]
  - note: "1 is smaller — push it too"
    values: [2, 1]
  - note: "5 pops everything smaller: 1 and 2 both get their answer"
    values: [2, 1]
    activeIndex: 1
  - note: "Stack holds only 5"
    values: [5]
\`\`\``,
};
