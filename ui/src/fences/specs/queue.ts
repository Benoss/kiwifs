import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { CANVAS_ATTRS, anyValue, bool, enumOf, many, number, objectList, string } from "./common";

const QueueView = lazy(() =>
  import("@kw/widgets/QueueView").then((m) => ({ default: m.QueueView })),
);

export const queueSpec: FenceSpec = {
  lang: "queue",
  aliases: ["ringbuffer", "ring-buffer"],
  description:
    "FIFO: BFS frontiers, work queues, sliding windows. `layout: ring` shows a circular buffer, where front and back crossing the end is the point.",
  component: QueueView,
  required: ["values"],
  schema: {
    attributes: {
      values: {
        type: "array",
        required: true,
        description:
          "Slot contents. In `ring` layout this is the whole buffer, with `null` for an empty slot.",
      },
      front: number("Index of the head, wrapped into the buffer. Defaults to 0, where the front marker is drawn."),
      back: number("Index one past the tail — where the next enqueue lands."),
      capacity: number("Buffer size, at most 1024. Defaults to `values.length`.", false),
      layout: enumOf(["horizontal", "ring"], "Default horizontal.", false),
      size: number(
        "How many slots hold data, counted from `front`. Tells a full ring from an empty one when front and back coincide; slots outside the window draw as stale.",
      ),
      activeIndices: many("Slots active this step."),
      highlightIndices: many("Secondary-highlighted slots."),
      dimIndices: many("Dimmed slots."),
      selected: many("Slot indices drawn as selected."),
      pointers: objectList("Extra markers beside slots: `{index, label, color?}`. In a ring the index wraps."),
      showIndices: bool("Show slot indices. Default true.", false),
      frontLabel: string('Label on the head end. Default "front".', false),
      backLabel: string('Label on the tail end. Default "back".', false),
      title: string("Caption above the queue.", false),
      empty: string("Text shown when every slot is empty.", false),
      slotSize: number("Slot size, px. Default 44.", false),
      radius: number("Ring radius, px. Defaults to whatever fits the slots, at least 86.", false),
      why: anyValue("Slot index → explanation, revealed on select."),
      widgetId: string("Name for the inspect bus.", false),
      ...CANVAS_ATTRS,
    },
  },
  example: `\`\`\`queue id=ring layout=ring caption="A ring buffer wrapping past the end"
capacity: 6
values: [null, null, null, null, null, null]
front: 0
back: 0
steps:
  - note: "Empty: front and back coincide"
    size: 0
  - note: "Enqueue three; back advances"
    values: [a, b, c, null, null, null]
    back: 3
    size: 3
    activeIndices: [2]
  - note: "Dequeue two; front advances, the slots are not cleared"
    values: [a, b, c, null, null, null]
    front: 2
    back: 3
    size: 1
    dimIndices: [0, 1]
  - note: "Enqueue four more — back wraps past the end to slot 1"
    values: [g, h, c, d, e, f]
    front: 2
    back: 2
    size: 6
    activeIndices: [0, 1]
\`\`\``,
};
