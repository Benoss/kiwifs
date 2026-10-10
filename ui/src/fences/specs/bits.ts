import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeBits } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, enumOf, many, number, objectList, string } from "./common";

const BitsView = lazy(() =>
  import("@kw/widgets/BitsView").then((m) => ({ default: m.BitsView })),
);

export const bitsSpec: FenceSpec = {
  lang: "bits",
  aliases: ["bitmask", "kiwi-bits"],
  description:
    "A value as labelled bits: bitmask DP, flag registers, permission sets, two's complement, IEEE-754 layouts.",
  component: BitsView,
  required: ["value"],
  schema: {
    attributes: {
      value: { type: "number", required: true, description: "The value to show." },
      bits: number("How many bits to draw. Defaults to the value's bit length.", false),
      labels: { type: "array", description: "What each bit stands for, indexed by bit position (bit 0 = least significant)." },
      label: string("Row title, e.g. `mask`."),
      activeBits: many("Bit positions being set or tested this step."),
      readBits: many("Bit positions read by this step."),
      highlightBits: many("Secondary-highlighted bit positions."),
      pointers: objectList("Pointers by bit position: `{bit, label, color?, side?}`."),
      arrows: objectList("Arcs between bit positions: `{from, to, label?, dashed?}`."),
      fields: objectList("Named bit ranges drawn as brackets: `{from, to, label, color?}` — sign, exponent, mantissa."),
      decode: enumOf(
        ["uint", "twos", "ieee32", "ieee64", "hex", "raw"],
        "Summary row interpretation. Default uint.",
        false,
      ),
      lsbFirst: bool("Draw bit 0 on the left. Default false (most significant first).", false),
      showSummary: bool("Show the decimal value and popcount beside the bits. Default true.", false),
      cellSize: number("Cell size, px.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeBits(props as Parameters<typeof summarizeBits>[0]),
  example: `\`\`\`bits id=subsets caption="Bitmask DP: visiting city 2"
bits: 4
labels: [A, B, C, D]
steps:
  - note: "Start at A only"
    value: 1
    activeBits: [0]
  - note: "Add C to the visited set"
    value: 5
    activeBits: [2]
    readBits: [0]
  - note: "All four visited — the subproblem is complete"
    value: 15
    activeBits: [1, 3]
\`\`\``,
};
