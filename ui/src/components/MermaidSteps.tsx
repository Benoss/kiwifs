import { detectStepsKind, truncateSequence } from "@kw/lib/stepsBlock";
import { MermaidDiagram } from "./MermaidDiagram";

export interface MermaidStepsProps {
  /** Mermaid source, unchanged across steps. */
  diagram: string;
  kind?: "flowchart" | "sequence";
  /** Node ids to emphasise this step. */
  focus?: string[];
  /** Node ids to fade this step. */
  dim?: string[];
  /** Sequence diagrams: show the first N messages. 1-based. */
  messages?: number;
  onNavigate?: (path: string) => void;
}

/**
 * The diagram half of a `kiwi-steps` fence.
 *
 * A sequence diagram reveals itself message by message, which means the chart
 * handed to mermaid changes per step; a flowchart is one chart with different
 * nodes lit. Keeping that distinction here lets `TypedFence` treat the two the
 * same way everything else is treated — props in, picture out.
 */
export function MermaidSteps({ diagram, kind, focus, dim, messages, onNavigate }: MermaidStepsProps) {
  const resolved = kind ?? detectStepsKind(diagram);
  const chart = resolved === "sequence" ? truncateSequence(diagram, messages ?? 1) : diagram;
  return <MermaidDiagram chart={chart} focus={focus} dim={dim} onNavigate={onNavigate} />;
}
