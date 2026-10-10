import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { summarizeMap } from "@kw/widgets/widgetA11y";
import { CANVAS_ATTRS, anyValue, bool, enumOf, many, number, numberList, objectList, string } from "./common";

const MapView = lazy(() =>
  import("@kw/widgets/MapView").then((m) => ({ default: m.MapView })),
);

export const mapSpec: FenceSpec = {
  lang: "map",
  aliases: ["hashmap", "hashtable", "kiwi-hashmap"],
  description:
    "Hash slots, chains and probe paths: hash tables, caches, symbol tables, routing tables, or a plain unordered dictionary.",
  component: MapView,
  required: ["slots", "entries"],
  schema: {
    attributes: {
      mode: enumOf(
        ["chain", "open", "map"],
        'How to draw it: "chain" for buckets, "open" for open addressing with tombstones, "map" for an unordered dictionary. Inferred from `slots` / `entries`.',
        false,
      ),
      capacity: number("Slot count. Defaults to `slots.length`."),
      slots: {
        type: "array",
        description:
          'One entry per slot: `null` empty, `"DEL"` a tombstone, `{key, value?}`, or a list of those for a chain.',
      },
      entries: objectList('`{key, value?}` for `mode: "map"` — a frequency map, a seen-set.'),
      hashOf: { type: "object", description: "Key → slot, shown as an `h(k)=i` badge." },
      activeSlots: many("Slots being written this step."),
      highlightSlots: many("Secondary-highlighted slots."),
      dimSlots: many("Dimmed slots."),
      activeKey: { type: ["string", "number"], description: "The key being inserted or looked up this step." },
      probePath: numberList("Slots visited in order, numbered above the row."),
      tombstones: many("Slots holding a tombstone, if not already `\"DEL\"`."),
      showLoadFactor: bool("Show α = n/m. Default true.", false),
      showIndices: bool("Index captions under the slots. Default true.", false),
      slotWidth: number("Slot width, px. Default 54.", false),
      why: anyValue("Slot index → explanation, revealed on select."),
      widgetId: string("Name for the inspect bus, for cross-widget linking.", false),
      ...CANVAS_ATTRS,
    },
  },
  summarize: (props) => summarizeMap(props as Parameters<typeof summarizeMap>[0]),
  example: `\`\`\`map id=probe caption="Linear probing into a full-ish table"
mode: open
capacity: 8
hashOf: {apple: 3, mango: 3}
slots:
  - null
  - null
  - null
  - {key: apple, value: 1}
  - null
  - null
  - null
  - null
steps:
  - note: "h(mango) = 3, but slot 3 is taken by apple"
    activeKey: mango
    activeSlots: [3]
    probePath: [3]
  - note: "Probe forward: slot 4 is free"
    activeKey: mango
    activeSlots: [4]
    probePath: [3, 4]
  - note: "Inserted. α = 2/8 — plenty of headroom"
    slots:
      - null
      - null
      - null
      - {key: apple, value: 1}
      - {key: mango, value: 2}
      - null
      - null
      - null
\`\`\``,
};
