import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { countSequenceMessages, detectStepsKind } from "@kw/lib/stepsBlock";
import { enumOf, number, string, stringList } from "./common";

const MermaidSteps = lazy(() =>
  import("@kw/components/MermaidSteps").then((m) => ({ default: m.MermaidSteps })),
);

/**
 * `kiwi-steps` predates the fence platform and had its own copy of the
 * playback sandwich. It is a spec now, so there is one implementation of
 * "canvas, note, code, transport" — and a stepped diagram can share a clock
 * with the array or table standing next to it.
 */
export const stepsSpec: FenceSpec = {
  lang: "kiwi-steps",
  aliases: ["steps", "mermaid-steps"],
  description:
    "A mermaid diagram walked one step at a time: focus and dim nodes, reveal sequence messages, highlight code in lockstep.",
  component: MermaidSteps,
  required: ["diagram"],
  needsNavigate: true,
  schema: {
    attributes: {
      diagram: {
        type: "string",
        required: true,
        description: "Mermaid source. Unchanged across steps.",
        steppable: false,
      },
      kind: enumOf(
        ["flowchart", "sequence"],
        "Detected from the diagram's first line; set it only to override.",
        false,
      ),
      focus: stringList("Node ids to emphasise this step."),
      dim: stringList("Node ids to fade this step."),
      messages: number("Sequence diagrams: show the first N messages. Defaults to one more per step."),
      caption: string("Caption under the diagram.", false),
    },
  },
  /**
   * A sequence diagram that does not say how many messages to show means "one
   * more than last step" — the only sensible reading, and the reason authors
   * rarely write `messages:` at all.
   */
  prepare(parsed) {
    const diagram = String(parsed.base.diagram ?? "");
    const kind = (parsed.base.kind as string) || detectStepsKind(diagram);
    if (kind !== "sequence" || parsed.steps.length === 0) return parsed;
    const total = Math.max(1, countSequenceMessages(diagram));
    return {
      ...parsed,
      steps: parsed.steps.map((step, i) => ({
        ...step,
        messages: step.messages ?? Math.min(i + 1, total),
      })),
    };
  },
  summarize: (props) =>
    `Stepped ${(props as { kind?: string }).kind ?? "flowchart"} diagram.`,
  example: `\`\`\`kiwi-steps id=write-path caption="A write through the pipeline"
diagram: |
  flowchart LR
    A[Client] --> B[Storage]
    B --> C[Git commit]
    C --> D[Index update]
    D --> E[SSE broadcast]
steps:
  - note: "The client PUTs a page"
    focus: [A]
    dim: [C, D, E]
  - note: "Bytes land on disk — files are the source of truth"
    focus: [B]
    dim: [D, E]
  - note: "The commit makes the version addressable"
    focus: [C]
    dim: [E]
  - note: "Indexes are derivative, so they come last"
    focus: [D, E]
\`\`\``,
};
