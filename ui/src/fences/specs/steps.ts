import { lazy } from "react";
import type { FenceSpec } from "../registry";
import { countSequenceMessages, detectStepsKind } from "@kw/lib/stepsBlock";
import { enumOf, number, string } from "./common";

const MermaidSteps = lazy(() =>
  import("@kw/components/MermaidSteps").then((m) => ({ default: m.MermaidSteps })),
);

/** `focus: [A, B]`, or `focus: A, B` as the original kiwi-steps allowed. */
function idList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value).split(/[\s,]+/).filter(Boolean);
}

/**
 * `kiwi-steps` predates the fence platform and had its own copy of the
 * playback sandwich. It is a spec now, so there is one implementation of
 * "canvas, note, code, transport" — and a stepped diagram can share a clock
 * with the array or table standing next to it.
 *
 * Its bodies keep their original meaning: each step names its own focus and
 * dim sets rather than patching the previous step's.
 */
export const stepsSpec: FenceSpec = {
  lang: "steps",
  aliases: ["kiwi-steps", "mermaid-steps"],
  description:
    "A mermaid diagram walked one step at a time: focus and dim nodes, reveal sequence messages, highlight code in lockstep. Each step stands alone rather than patching the one before.",
  component: MermaidSteps,
  required: ["diagram"],
  needsNavigate: true,
  independentSteps: true,
  requireSteps: true,
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
      focus: {
        type: ["array", "string"],
        items: "string",
        description: "Node ids to emphasise this step: a list, or `A, B`.",
      },
      dim: {
        type: ["array", "string"],
        items: "string",
        description: "Node ids to fade this step: a list, or `A, B`.",
      },
      messages: number("Sequence diagrams: show the first N messages. Defaults to the step's position."),
      caption: string("Caption under the diagram.", false),
    },
  },
  /**
   * A sequence diagram step that does not say how many messages to show
   * means "as many as its position" — the only sensible reading, and the
   * reason authors rarely write `messages:` at all. Read from what the step
   * itself wrote, so one explicit count does not freeze every later step.
   */
  prepare(parsed) {
    const diagram = String(parsed.base.diagram ?? "");
    const kind = (parsed.base.kind as string) || detectStepsKind(diagram);
    if (kind !== "sequence" || parsed.steps.length === 0) return parsed;
    const total = Math.max(1, countSequenceMessages(diagram));
    return {
      ...parsed,
      steps: parsed.steps.map((step, i) => {
        const written = parsed.patches[i]?.messages;
        const own = written == null ? NaN : Number(written);
        return { ...step, messages: Number.isFinite(own) ? own : Math.min(i + 1, total) };
      }),
    };
  },
  normalize: (body) => ({ ...body, focus: idList(body.focus), dim: idList(body.dim) }),
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
