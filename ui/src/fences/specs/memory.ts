import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { CANVAS_ATTRS, anyValue, bool, many, objectList, string } from "./common";

const MemoryView = lazy(() =>
  import("@kw/widgets/MemoryView").then((m) => ({ default: m.MemoryView })),
);

export const memorySpec: FenceSpec = {
  lang: "memory",
  aliases: ["heap", "stack-heap"],
  description:
    "Frames on the left, heap on the right, pointers between: aliasing, mutation, closures, recursion. Props are the Python Tutor trace format, so a recorded trace drops straight in.",
  component: MemoryView,
  required: ["frames", "heap"],
  // `frames` here means stack frames, not "one prop set per step". It is the
  // second spec to need this, which is the cost of `frames` as a reserved
  // name; `steps:` is what authors actually write.
  reclaims: ["frames"],
  schema: {
    attributes: {
      frames: objectList(
        "Call stack, outermost first: `{name, id?, vars: {k: value}, order?, returned?, active?}`. A value of `[REF, id]` points into the heap.",
      ),
      heap: {
        type: "object",
        description:
          'Objects by id, tagged: `["LIST", 1, 2]`, `["DICT", ["k", 1]]`, `["INSTANCE", "Node", ["val", 1]]`, `["TUPLE", …]`, `["SET", …]`. An untagged `{field: value}` draws as an object\'s fields.',
      },
      activeFrame: {
        type: ["string", "number"],
        description: "Which frame is executing: a frame `id`, or a number for its index in `frames`. Defaults to the innermost.",
      },
      activeIds: many("Heap ids to emphasise this step."),
      highlightIds: many("Secondary-highlighted heap ids."),
      dimIds: many("Dimmed heap ids — garbage, or a frame about to return."),
      inlinePrimitives: bool(
        "Draw a frame variable's primitive inside its slot. Default true; `false` boxes each one on the heap with an arrow, Python Tutor's \"render all objects on the heap\".",
        false,
      ),
      framesLabel: string('Caption above the frames column. Default "Frames".', false),
      heapLabel: string('Caption above the heap column. Default "Objects".', false),
      why: anyValue("Heap id → explanation, revealed on select."),
      widgetId: string("Name for the inspect bus.", false),
      ...CANVAS_ATTRS,
    },
  },
  example: `\`\`\`memory id=alias caption="Why mutating b changed a"
frames:
  - name: "<module>"
    vars: {a: [REF, 1], b: [REF, 1]}
heap:
  1: [LIST, 1, 2, 3]
steps:
  - note: "a = [1, 2, 3] allocates one list"
    frames:
      - {name: "<module>", vars: {a: [REF, 1]}}
    activeIds: [1]
  - note: "b = a copies the pointer, not the list — both names are the one object"
    frames:
      - {name: "<module>", vars: {a: [REF, 1], b: [REF, 1]}}
    activeIds: [1]
  - note: "b.append(4) mutates that object, so a sees it too"
    heap:
      1: [LIST, 1, 2, 3, 4]
    activeIds: [1]
    breakpoint: true
\`\`\``,
};
