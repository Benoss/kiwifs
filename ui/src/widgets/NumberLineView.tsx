import { useId } from "react";
import { toSet, type Many } from "./sets";
import { SvgLabel } from "./WidgetText";
import { niceTicks } from "./plotLayout";
import { assignLanes } from "./lanes";
import { summarizeNumberLine } from "./widgetA11y";

/**
 * A single value axis.
 *
 * Inequalities, binary-search-on-answer buckets, interval arithmetic, SLO
 * thresholds, two pointers on a *value* rather than an index. Not
 * `TimelineView`, which is Gantt lanes over time; not `PlotView`, which needs
 * a second dimension to say anything.
 *
 * Endpoint styles follow Manim and Desmos: a filled dot is closed, a hollow
 * one is open, a cross is excluded.
 */

export type PointStyle = "closed" | "open" | "cross";

export interface NumberLinePoint {
  id?: string | number;
  x: number;
  label?: string;
  style?: PointStyle;
  color?: string;
}

export interface NumberLineInterval {
  id?: string | number;
  from: number;
  to: number;
  /** `true` draws a hollow left endpoint — `(from, to]`. */
  fromOpen?: boolean;
  toOpen?: boolean;
  label?: string;
  color?: string;
  /** Row to draw on. Omit to let overlapping intervals stack. */
  row?: number;
}

export interface NumberLineRay {
  id?: string | number;
  at: number;
  dir: "left" | "right";
  open?: boolean;
  label?: string;
  color?: string;
}

export interface NumberLineMark {
  at: number;
  label?: string;
  color?: string;
}

export interface NumberLinePointer {
  at: number;
  label: string;
  color?: string;
}

export interface NumberLineViewProps {
  min: number;
  max: number;
  /** Tick spacing. Omit for automatic nice ticks. */
  step?: number;
  /** Explicit tick values, overriding `step`. */
  ticks?: number[];
  /** Print the number under each tick. Default true. */
  includeNumbers?: boolean;
  /** `"log"` needs a positive `min`. Default "linear". */
  scale?: "linear" | "log";
  points?: NumberLinePoint[];
  intervals?: NumberLineInterval[];
  rays?: NumberLineRay[];
  marks?: NumberLineMark[];
  /** Named pointers above the axis — `lo`, `hi`, `mid`. */
  pointers?: NumberLinePointer[];
  /** Position of a sweep cursor. */
  sweep?: number;
  sweepLabel?: string;
  activeIds?: Many<string | number>;
  highlightIds?: Many<string | number>;
  dimIds?: Many<string | number>;
  /** Axis caption. */
  label?: string;
  width?: number;
  activeColor?: string;
  highlightColor?: string;
  ariaLabel?: string;
}

const DEFAULTS = {
  activeColor: "var(--kw-widget-active, #a78bfa)",
  highlightColor: "var(--kw-widget-highlight, #22c55e)",
  dimColor: "var(--kw-widget-dim, #64748b)",
  border: "var(--kw-widget-border, #3f3f46)",
  text: "var(--kw-widget-text, #e5e7eb)",
  surface: "var(--kw-widget-surface, #18181b)",
  bar: "var(--kw-widget-bar, #94a3b8)",
  width: 560,
};

const PAD_X = 34;
const ROW_H = 20;
const AXIS_Y_FROM_TOP = 26;

export function NumberLineView({
  min,
  max,
  step,
  ticks,
  includeNumbers = true,
  scale: scaleKind = "linear",
  points = [],
  intervals = [],
  rays = [],
  marks = [],
  pointers = [],
  sweep,
  sweepLabel,
  activeIds: activeIdsIn,
  highlightIds: highlightIdsIn,
  dimIds: dimIdsIn,
  label,
  width = DEFAULTS.width,
  activeColor = DEFAULTS.activeColor,
  highlightColor = DEFAULTS.highlightColor,
  ariaLabel,
}: NumberLineViewProps) {
  const activeIds = toSet(activeIdsIn);
  const highlightIds = toSet(highlightIdsIn);
  const dimIds = toSet(dimIdsIn);
  const uid = useId().replace(/:/g, "");
  const arrowId = `kw-nl-arrow-${uid}`;

  const logScale = scaleKind === "log" && min > 0 && max > 0;
  const plotW = width - PAD_X * 2;
  const project = (v: number): number => {
    if (logScale) {
      const lo = Math.log(min);
      const hi = Math.log(max);
      const t = (Math.log(Math.max(v, Number.EPSILON)) - lo) / (hi - lo || 1);
      return PAD_X + t * plotW;
    }
    return PAD_X + ((v - min) / (max - min || 1)) * plotW;
  };

  const rows = assignLanes(
    intervals.map((iv) => ({
      start: Math.min(iv.from, iv.to),
      end: Math.max(iv.from, iv.to),
      lane: iv.row,
    })),
  );
  const rowCount = intervals.length ? Math.max(...rows) + 1 : 0;

  const axisY = AXIS_Y_FROM_TOP + rowCount * ROW_H;
  const height = axisY + (includeNumbers ? 30 : 16) + (label ? 14 : 0);

  const tickValues =
    ticks ??
    (step && step > 0
      ? Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step)
      : niceTicks(min, max, 6));

  const idOf = (item: { id?: string | number }, kind: string, i: number) => item.id ?? `${kind}${i}`;
  const toneOf = (id: string | number, base?: string) => {
    if (activeIds.has(id)) return { color: activeColor, opacity: 1, weight: 2.5 };
    if (highlightIds.has(id)) return { color: highlightColor, opacity: 1, weight: 2.5 };
    if (dimIds.has(id)) return { color: DEFAULTS.dimColor, opacity: 0.4, weight: 1.5 };
    return { color: base ?? DEFAULTS.bar, opacity: 1, weight: 2 };
  };

  /** Closed = filled, open = hollow, cross = ✕. Manim / Desmos convention. */
  const endpoint = (x: number, y: number, open: boolean, color: string, style?: PointStyle) => {
    if (style === "cross") {
      return (
        <g>
          <line x1={x - 4} y1={y - 4} x2={x + 4} y2={y + 4} stroke={color} strokeWidth={2} />
          <line x1={x - 4} y1={y + 4} x2={x + 4} y2={y - 4} stroke={color} strokeWidth={2} />
        </g>
      );
    }
    return (
      <circle
        cx={x}
        cy={y}
        r={4.5}
        fill={open ? DEFAULTS.surface : color}
        stroke={color}
        strokeWidth={2}
      />
    );
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "0.5rem 0", overflow: "auto" }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel ?? summarizeNumberLine({ min, max, points, intervals })}
        style={{ display: "block" }}
      >
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={DEFAULTS.bar} />
          </marker>
        </defs>

        {/* Stacked interval rows above the axis */}
        {intervals.map((iv, i) => {
          const id = idOf(iv, "iv", i);
          const tone = toneOf(id, iv.color);
          const y = AXIS_Y_FROM_TOP + (rowCount - 1 - rows[i]!) * ROW_H;
          const x1 = project(Math.min(iv.from, iv.to));
          const x2 = project(Math.max(iv.from, iv.to));
          const leftOpen = iv.from <= iv.to ? Boolean(iv.fromOpen) : Boolean(iv.toOpen);
          const rightOpen = iv.from <= iv.to ? Boolean(iv.toOpen) : Boolean(iv.fromOpen);
          return (
            <g key={`iv${i}`} opacity={tone.opacity} style={{ transition: "opacity 0.25s ease" }}>
              <line x1={x1} y1={y} x2={x2} y2={y} stroke={tone.color} strokeWidth={tone.weight + 1.5} />
              {endpoint(x1, y, leftOpen, tone.color)}
              {endpoint(x2, y, rightOpen, tone.color)}
              {iv.label && (
                <SvgLabel
                  x={(x1 + x2) / 2}
                  y={y - 9}
                  text={iv.label}
                  anchor="middle"
                  fill={tone.color}
                  fontSize={10}
                  fontWeight={600}
                  fontFamily="ui-monospace, SFMono-Regular, monospace"
                  halo={DEFAULTS.surface}
                />
              )}
            </g>
          );
        })}

        {/* Rays — an inequality with no far end */}
        {rays.map((ray, i) => {
          const id = idOf(ray, "ray", i);
          const tone = toneOf(id, ray.color);
          const x = project(ray.at);
          const end = ray.dir === "left" ? PAD_X - 14 : PAD_X + plotW + 14;
          return (
            <g key={`ray${i}`} opacity={tone.opacity}>
              <line
                x1={x}
                y1={axisY}
                x2={end}
                y2={axisY}
                stroke={tone.color}
                strokeWidth={tone.weight + 1.5}
                markerEnd={`url(#${arrowId})`}
              />
              {endpoint(x, axisY, Boolean(ray.open), tone.color)}
              {ray.label && (
                <SvgLabel
                  x={x + (ray.dir === "left" ? -10 : 10)}
                  y={axisY - 10}
                  text={ray.label}
                  anchor={ray.dir === "left" ? "end" : "start"}
                  fill={tone.color}
                  fontSize={10}
                  fontWeight={600}
                  fontFamily="ui-monospace, SFMono-Regular, monospace"
                  halo={DEFAULTS.surface}
                />
              )}
            </g>
          );
        })}

        {/* The axis */}
        <line x1={PAD_X} y1={axisY} x2={PAD_X + plotW} y2={axisY} stroke={DEFAULTS.border} strokeWidth={1.5} />

        {tickValues.map((t, i) => (
          <g key={`t${i}`}>
            <line x1={project(t)} y1={axisY - 4} x2={project(t)} y2={axisY + 4} stroke={DEFAULTS.border} strokeWidth={1} />
            {includeNumbers && (
              <text
                x={project(t)}
                y={axisY + 16}
                textAnchor="middle"
                fill={DEFAULTS.dimColor}
                fontSize={9}
                fontFamily="ui-monospace, SFMono-Regular, monospace"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {Number.isInteger(t) ? t : Number(t.toFixed(2))}
              </text>
            )}
          </g>
        ))}

        {/* Dashed reference marks */}
        {marks.map((m, i) => (
          <g key={`m${i}`}>
            <line
              x1={project(m.at)}
              y1={8}
              x2={project(m.at)}
              y2={axisY}
              stroke={m.color ?? DEFAULTS.dimColor}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.7}
            />
            {m.label && (
              <SvgLabel
                x={project(m.at)}
                y={7}
                text={m.label}
                anchor="middle"
                fill={m.color ?? DEFAULTS.dimColor}
                fontSize={9}
                fontWeight={600}
                fontFamily="system-ui, sans-serif"
              />
            )}
          </g>
        ))}

        {/* Points on the axis */}
        {points.map((p, i) => {
          const id = idOf(p, "pt", i);
          const tone = toneOf(id, p.color);
          const x = project(p.x);
          return (
            <g key={`pt${i}`} opacity={tone.opacity} style={{ transition: "opacity 0.25s ease" }}>
              {endpoint(x, axisY, p.style === "open", tone.color, p.style)}
              {p.label && (
                <SvgLabel
                  x={x}
                  y={axisY - 11}
                  text={p.label}
                  anchor="middle"
                  fill={tone.color}
                  fontSize={10}
                  fontWeight={700}
                  fontFamily="ui-monospace, SFMono-Regular, monospace"
                  halo={DEFAULTS.surface}
                />
              )}
            </g>
          );
        })}

        {/* Named pointers */}
        {pointers.map((ptr, i) => (
          <g key={`ptr${i}`}>
            <path
              d={`M ${project(ptr.at)} ${axisY - 7} l -4 -7 l 8 0 Z`}
              fill={ptr.color ?? activeColor}
            />
            <SvgLabel
              x={project(ptr.at)}
              y={axisY - 18}
              text={ptr.label}
              anchor="middle"
              fill={ptr.color ?? activeColor}
              fontSize={10}
              fontWeight={700}
              fontFamily="ui-monospace, SFMono-Regular, monospace"
              halo={DEFAULTS.surface}
            />
          </g>
        ))}

        {/* Sweep cursor */}
        {sweep !== undefined && (
          <g>
            <line x1={project(sweep)} y1={6} x2={project(sweep)} y2={axisY + 6} stroke={activeColor} strokeWidth={2} />
            <circle cx={project(sweep)} cy={6} r={3} fill={activeColor} />
            {sweepLabel && (
              <SvgLabel
                x={project(sweep) + 6}
                y={8}
                text={sweepLabel}
                fill={activeColor}
                fontSize={10}
                fontWeight={700}
                fontFamily="ui-monospace, SFMono-Regular, monospace"
                halo={DEFAULTS.surface}
              />
            )}
          </g>
        )}

        {label && (
          <SvgLabel
            x={PAD_X + plotW / 2}
            y={height - 3}
            text={label}
            anchor="middle"
            fill={DEFAULTS.dimColor}
            fontSize={10}
            fontWeight={600}
            fontFamily="system-ui, sans-serif"
          />
        )}
      </svg>
    </div>
  );
}

/** Shading the half of the line where a predicate holds. Kept for 5.2. */
export function shadeWhere(
  min: number,
  max: number,
  holds: (x: number) => boolean,
  samples = 200,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const dx = (max - min) / samples;
  let start: number | null = null;
  for (let i = 0; i <= samples; i++) {
    const x = min + i * dx;
    const on = holds(x);
    if (on && start === null) start = x;
    if (!on && start !== null) {
      out.push({ from: start, to: x });
      start = null;
    }
  }
  if (start !== null) out.push({ from: start, to: max });
  return out;
}
