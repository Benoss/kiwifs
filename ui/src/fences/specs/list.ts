import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeLinkedList } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, many, number, objectList } from "./common";

const LinkedListView = lazy(() =>
  import("@kw/widgets/LinkedListView").then((m) => ({ default: m.LinkedListView })),
);

export const listSpec: FenceSpec = {
  lang: "list",
  aliases: ["linkedlist", "linked-list", "kiwi-linkedlist"],
  description:
    "A linked list: reversal, cycle detection, LRU chains, random pointers. A numeric `next` is how you draw a cycle back into the middle.",
  component: LinkedListView,
  required: ["nodes"],
  schema: {
    attributes: {
      nodes: {
        type: "array",
        items: "object",
        required: true,
        description:
          "`{value, next?}`. `next` omitted or `true` means the following node, `false` means null, a number means that index — a cycle.",
      },
      activeIndex: number("Index of the active node."),
      highlightIndices: many("Secondary-highlighted indices."),
      dimIndices: many("Dimmed indices."),
      pointers: objectList("Named pointers: `{index, label, color?}` — `slow`, `fast`, `prev`, `curr`."),
      doubly: bool("Draw a backward arrow beside each forward one.", false),
      edges: objectList('Arcs over the chain: `{from, to, label?, side?: "above"|"below"}` — random pointers, child links.'),
      showNull: bool("Draw a null terminator. Default true.", false),
      nodeWidth: number("Node width, px.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeLinkedList(props as Parameters<typeof summarizeLinkedList>[0]),
  example: `\`\`\`list id=floyd caption="Floyd's cycle detection"
nodes:
  - {value: 1}
  - {value: 2}
  - {value: 3}
  - {value: 4}
  - {value: 5, next: 2}
steps:
  - note: "slow and fast both start at the head"
    pointers: [{index: 0, label: slow}, {index: 0, label: fast}]
  - note: "slow moves one, fast moves two"
    pointers: [{index: 1, label: slow}, {index: 2, label: fast}]
  - note: "fast has entered the cycle"
    pointers: [{index: 2, label: slow}, {index: 4, label: fast}]
  - note: "They meet inside the cycle — there is one"
    pointers: [{index: 3, label: "slow,fast"}]
    activeIndex: 3
    breakpoint: true
\`\`\``,
};
