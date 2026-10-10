import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeSequence } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, bool, enumOf, number, objectList } from "./common";

const SequenceView = lazy(() =>
  import("@kw/widgets/SequenceView").then((m) => ({ default: m.SequenceView })),
);

export const sequenceSpec: FenceSpec = {
  lang: "sequence",
  aliases: ["seq"],
  description:
    "A message sequence between participants: API flows, consensus rounds, handshakes, retries. Steps reveal one message at a time.",
  component: SequenceView,
  required: ["participants"],
  // `frames` here means the alt/loop boxes, not one prop set per step.
  reclaims: ["frames"],
  schema: {
    attributes: {
      participants: {
        type: "array",
        items: "object",
        required: true,
        description: "`{id, label?, shape?, color?}` in left-to-right order.",
        steppable: false,
      },
      items: {
        type: "array",
        items: "object",
        required: true,
        description:
          '`{from, to, label?, kind?: "sync"|"async"|"reply"}`, or `{note, over}`, or `{divider}`.',
        steppable: false,
      },
      step: number("Items revealed so far; item `step - 1` is active. Defaults to one more per playback step."),
      future: enumOf(["ghost", "hide"], "How to draw items after the active one. Default ghost.", false),
      frames: objectList('Grouping boxes: `{kind?, label?, from, to, color?}` — "alt [cache miss]", "loop".'),
      numbered: bool("Prefix each message with its number.", false),
      packet: bool("Move a dot along the active message. Default true.", false),
      zoomable: bool("Wrap in a zoom / pan viewport.", false),
      width: number("Maximum display width, px.", false),
      ...CANVAS_ATTRS,
    },
  },
  /**
   * A sequence diagram with no explicit `step` means "one more message per
   * playback step", which is what every author writing a flow actually wants.
   */
  prepare(parsed) {
    if (parsed.steps.length === 0) return parsed;
    const total = Array.isArray(parsed.base.items) ? parsed.base.items.length : 0;
    return {
      ...parsed,
      steps: parsed.steps.map((s, i) => ({ ...s, step: s.step ?? Math.min(i + 1, Math.max(total, 1)) })),
    };
  },
  summarize: (props) => summarizeSequence(props as Parameters<typeof summarizeSequence>[0]),
  example: `\`\`\`sequence id=cache caption="Read-through cache on a miss"
participants:
  - {id: C, label: Client, shape: person}
  - {id: A, label: API}
  - {id: R, label: Redis, shape: cylinder}
  - {id: D, label: Postgres, shape: cylinder}
items:
  - {from: C, to: A, label: "GET /page/42"}
  - {from: A, to: R, label: "GET page:42"}
  - {from: R, to: A, label: "(nil)", kind: reply}
  - {from: A, to: D, label: "SELECT …"}
  - {from: D, to: A, label: row, kind: reply}
  - {from: A, to: R, label: "SETEX page:42 60", kind: async}
  - {from: A, to: C, label: "200 OK", kind: reply}
frames:
  - {kind: alt, label: "[cache miss]", from: 3, to: 5}
steps:
  - note: "The client asks for a page"
  - note: "The API checks Redis first"
  - note: "Miss — nothing cached"
  - note: "Fall through to Postgres"
  - note: "Row comes back"
  - note: "Populate the cache, without blocking the response"
  - note: "Respond. The next read is a hit."
\`\`\``,
};
