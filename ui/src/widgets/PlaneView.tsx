import { useId } from "react";
import { alpha } from "./colors";
import { toSet, type Many } from "./sets";
import { SvgLabel } from "./WidgetText";
import { niceTicks } from "./plotLayout";
import { summarizePlane } from "./widgetA11y";

/**
 * A coordinate plane in data units.
 *
 * Geometry, sweep lines, hulls, vectors, Red Blob–style tile maps, plain
 * worked coordinate examples. Not `GraphView`, whose positions are pixels and
 * whose job is connectivity; not `PlotView`, which is a chart of series.
 *
 * It draws what it is given and computes nothing: a convex hull is a polygon
 * the author supplies, step by step. Putting the algorithm in the widget is
 * how you end up with a ConvexHullView that fits one lecture.
 *
 * Param names follow Manim's `NumberPlane` and the Desmos API.
 */

export type XY = readonly [number, number];
/** A point by id, or a literal coordinate pair. */
export type PointRef = string | number | XY;

export interface PlanePoint {
  id?: string | number;
  x: number;
  y: number;
  label?: string;
  style?: "dot" | "open" | "cross" | "square";
  color?: string;
}

export interface PlaneSegment {
  id?: string | number;
  from: PointRef;
  to: PointRef;
  label?: string;
  color?: string;
  dashed?: boolean;
  /** Arrowhead at `to`. */
  arrow?: boolean;
}

export interface PlanePolygon {
  id?: string | number;
  points: PointRef[];
  label?: string;
  color?: string;
  /** Leave the ring open — a hull still being built. */
  open?: boolean;
  fill?: boolean;
}

export interface PlaneCircle {
  id?: string | number;
  at: PointRef;
  r: number;
  label?: string;
  color?: string;
  dashed?: boolean;
}

export interface PlaneVector {
  id?: string | number;
  from?: PointRef;
  to: PointRef;
  label?: string;
  color?: string;
}

export interface PlaneLabel {
  at: PointRef;
  text: string;
  color?: string;
  dx?: number;
  dy?: number;
}

export interface PlaneSweep {
  axis: "x" | "y" | "angle";
  at: number;
  /** Origin for `axis: "angle"`, in data units. Default [0, 0]. */
  origin?: XY;
  label?: string;
}

export interface PlaneViewProps {
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  /** `[min, max]`, an alias for the pair above. */
  xRange?: readonly [number, number];
  yRange?: readonly [number, number];
  /** Draw the unit grid. Default true. */
  grid?: boolean;
  /** Draw the axes through the origin. Default true. */
  axes?: boolean;
  /** `"equal"` (default) keeps circles round; `"auto"` fills the box. */
  aspect?: "equal" | "auto";
  points?: PlanePoint[];
  segments?: PlaneSegment[];
  polygons?: PlanePolygon[];
  circles?: PlaneCircle[];
  vectors?: PlaneVector[];
  labels?: PlaneLabel[];
  sweep?: PlaneSweep;
  activeIds?: Many<string | number>;
  highlightIds?: Many<string | number>;
  dimIds?: Many<string | number>;
  xLabel?: string;
  yLabel?: string;
  width?: number;
  height?: number;
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
  width: 440,
  height: 340,
};

const PAD = { left: 34, right: 16, top: 16, bottom: 28 };

export function PlaneView({
  xMin,
  xMax,
  yMin,
  yMax,
  xRange,
  yRange,
  grid = true,
  axes = true,
  aspect = "equal",
  points = [],
  segments = [],
  polygons = [],
  circles = [],
  vectors = [],
  labels = [],
  sweep,
  activeIds: activeIdsIn,
  highlightIds: highlightIdsIn,
  dimIds: dimIdsIn,
  xLabel,
  yLabel,
  width = DEFAULTS.width,
  height = DEFAULTS.height,
  activeColor = DEFAULTS.activeColor,
  highlightColor = DEFAULTS.highlightColor,
  ariaLabel,
}: PlaneViewProps) {
  const activeIds = toSet(activeIdsIn);
  const highlightIds = toSet(highlightIdsIn);
  const dimIds = toSet(dimIdsIn);
  const uid = useId().replace(/:/g, "");
  const arrowId = `kw-pl-arrow-${uid}`;

  const x0 = xRange?.[0] ?? xMin ?? 0;
  const x1 = xRange?.[1] ?? xMax ?? 10;
  const y0 = yRange?.[0] ?? yMin ?? 0;
  const y1 = yRange?.[1] ?? yMax ?? 10;

  const boxW = width - PAD.left - PAD.right;
  const boxH = height - PAD.top - PAD.bottom;
  const spanX = x1 - x0 || 1;
  const spanY = y1 - y0 || 1;

  // Equal aspect means one data unit is the same number of pixels on both
  // axes — without it a circle is an ellipse and a right angle is a lie.
  const unit = aspect === "equal" ? Math.min(boxW / spanX, boxH / spanY) : 0;
  const scaleX = aspect === "equal" ? unit : boxW / spanX;
  const scaleY = aspect === "equal" ? unit : boxH / spanY;
  const drawW = scaleX * spanX;
  const drawH = scaleY * spanY;
  const offX = PAD.left + (boxW - drawW) / 2;
  const offY = PAD.top + (boxH - drawH) / 2;

  const px = (x: number) => offX + (x - x0) * scaleX;
  const py = (y: number) => offY + drawH - (y - y0) * scaleY;

  const byId = new Map<string, PlanePoint>();
  points.forEach((p, i) => byId.set(String(p.id ?? i), p));

  /** A ref is either a named point or a literal `[x, y]`. */
  const resolve = (ref: PointRef): XY | null => {
    if (Array.isArray(ref)) return ref as XY;
    const p = byId.get(String(ref));
    return p ? [p.x, p.y] : null;
  };

  const idOf = (item: { id?: string | number }, kind: string, i: number) => item.id ?? `${kind}${i}`;
  const toneOf = (id: string | number, base?: string) => {
    if (activeIds.has(id)) return { color: activeColor, opacity: 1, weight: 2.5 };
    if (highlightIds.has(id)) return { color: highlightColor, opacity: 1, weight: 2.25 };
    if (dimIds.has(id)) return { color: DEFAULTS.dimColor, opacity: 0.35, weight: 1.25 };
    return { color: base ?? DEFAULTS.bar, opacity: 1, weight: 1.75 };
  };

  const xTicks = niceTicks(x0, x1, 6).filter((t) => t >= x0 && t <= x1);
  const yTicks = niceTicks(y0, y1, 5).filter((t) => t >= y0 && t <= y1);

  const originX = x0 <= 0 && x1 >= 0 ? px(0) : null;
  const originY = y0 <= 0 && y1 >= 0 ? py(0) : null;

  const pointMarker = (p: PlanePoint, x: number, y: number, color: string) => {
    switch (p.style) {
      case "open":
        return <circle cx={x} cy={y} r={4.5} fill={DEFAULTS.surface} stroke={color} strokeWidth={2} />;
      case "square":
        return <rect x={x - 4} y={y - 4} width={8} height={8} fill={color} />;
      case "cross":
        return (
          <g stroke={color} strokeWidth={2}>
            <line x1={x - 4.5} y1={y - 4.5} x2={x + 4.5} y2={y + 4.5} />
            <line x1={x - 4.5} y1={y + 4.5} x2={x + 4.5} y2={y - 4.5} />
          </g>
        );
      default:
        return <circle cx={x} cy={y} r={4} fill={color} />;
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "0.5rem 0", overflow: "auto" }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          ariaLabel ??
          summarizePlane({ points, segments, polygons, circles, xMin: x0, xMax: x1, yMin: y0, yMax: y1 })
        }
        style={{ display: "block", maxWidth: "100%", fontVariantNumeric: "tabular-nums" }}
      >
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>

        {grid && (
          <g stroke={DEFAULTS.border} strokeWidth={0.75} opacity={0.35}>
            {xTicks.map((t) => (
              <line key={`gx${t}`} x1={px(t)} y1={offY} x2={px(t)} y2={offY + drawH} />
            ))}
            {yTicks.map((t) => (
              <line key={`gy${t}`} x1={offX} y1={py(t)} x2={offX + drawW} y2={py(t)} />
            ))}
          </g>
        )}

        <rect x={offX} y={offY} width={drawW} height={drawH} fill="none" stroke={DEFAULTS.border} strokeWidth={1} />

        {axes && (
          <g stroke={DEFAULTS.bar} strokeWidth={1.5}>
            {originY != null && <line x1={offX} y1={originY} x2={offX + drawW} y2={originY} />}
            {originX != null && <line x1={originX} y1={offY} x2={originX} y2={offY + drawH} />}
          </g>
        )}

        {/* Tick labels outside the box */}
        {xTicks.map((t) => (
          <text
            key={`tx${t}`}
            x={px(t)}
            y={offY + drawH + 14}
            textAnchor="middle"
            fill={DEFAULTS.dimColor}
            fontSize={9}
            fontFamily="ui-monospace, SFMono-Regular, monospace"
          >
            {Number.isInteger(t) ? t : Number(t.toFixed(2))}
          </text>
        ))}
        {yTicks.map((t) => (
          <text
            key={`ty${t}`}
            x={offX - 6}
            y={py(t)}
            textAnchor="end"
            dominantBaseline="central"
            fill={DEFAULTS.dimColor}
            fontSize={9}
            fontFamily="ui-monospace, SFMono-Regular, monospace"
          >
            {Number.isInteger(t) ? t : Number(t.toFixed(2))}
          </text>
        ))}

        {/* Polygons first, so points and segments land on top */}
        {polygons.map((poly, i) => {
          const id = idOf(poly, "poly", i);
          const tone = toneOf(id, poly.color);
          const pts = poly.points.map(resolve).filter((p): p is XY => p !== null);
          if (pts.length < 2) return null;
          const d =
            pts.map((p, j) => `${j === 0 ? "M" : "L"} ${px(p[0])} ${py(p[1])}`).join(" ") +
            (poly.open ? "" : " Z");
          const centroid = pts.reduce<[number, number]>((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
          return (
            <g key={`poly${i}`} opacity={tone.opacity} style={{ transition: "opacity 0.25s ease" }}>
              <path
                d={d}
                fill={poly.fill === false || poly.open ? "none" : alpha(tone.color, 18)}
                stroke={tone.color}
                strokeWidth={tone.weight}
                strokeLinejoin="round"
              />
              {poly.label && !poly.open && (
                <SvgLabel
                  x={px(centroid[0])}
                  y={py(centroid[1])}
                  text={poly.label}
                  anchor="middle"
                  dominantBaseline="central"
                  fill={tone.color}
                  fontSize={10}
                  fontWeight={600}
                  halo={DEFAULTS.surface}
                />
              )}
            </g>
          );
        })}

        {circles.map((c, i) => {
          const id = idOf(c, "circle", i);
          const tone = toneOf(id, c.color);
          const at = resolve(c.at);
          if (!at) return null;
          return (
            <g key={`circ${i}`} opacity={tone.opacity}>
              <circle
                cx={px(at[0])}
                cy={py(at[1])}
                r={c.r * scaleX}
                fill="none"
                stroke={tone.color}
                strokeWidth={tone.weight}
                strokeDasharray={c.dashed ? "5 4" : undefined}
              />
              {c.label && (
                <SvgLabel
                  x={px(at[0])}
                  y={py(at[1]) - c.r * scaleX - 5}
                  text={c.label}
                  anchor="middle"
                  fill={tone.color}
                  fontSize={10}
                  fontWeight={600}
                  halo={DEFAULTS.surface}
                />
              )}
            </g>
          );
        })}

        {segments.map((seg, i) => {
          const id = idOf(seg, "seg", i);
          const tone = toneOf(id, seg.color);
          const a = resolve(seg.from);
          const b = resolve(seg.to);
          if (!a || !b) return null;
          return (
            <g key={`seg${i}`} opacity={tone.opacity} color={tone.color}>
              <line
                x1={px(a[0])}
                y1={py(a[1])}
                x2={px(b[0])}
                y2={py(b[1])}
                stroke={tone.color}
                strokeWidth={tone.weight}
                strokeDasharray={seg.dashed ? "5 4" : undefined}
                markerEnd={seg.arrow ? `url(#${arrowId})` : undefined}
              />
              {seg.label && (
                <SvgLabel
                  x={(px(a[0]) + px(b[0])) / 2}
                  y={(py(a[1]) + py(b[1])) / 2 - 6}
                  text={seg.label}
                  anchor="middle"
                  fill={tone.color}
                  fontSize={10}
                  fontWeight={600}
                  halo={DEFAULTS.surface}
                />
              )}
            </g>
          );
        })}

        {vectors.map((v, i) => {
          const id = idOf(v, "vec", i);
          const tone = toneOf(id, v.color);
          const a = v.from ? resolve(v.from) : ([0, 0] as XY);
          const b = resolve(v.to);
          if (!a || !b) return null;
          return (
            <g key={`vec${i}`} opacity={tone.opacity} color={tone.color}>
              <line
                x1={px(a[0])}
                y1={py(a[1])}
                x2={px(b[0])}
                y2={py(b[1])}
                stroke={tone.color}
                strokeWidth={tone.weight + 0.5}
                markerEnd={`url(#${arrowId})`}
              />
              {v.label && (
                <SvgLabel
                  x={px(b[0]) + 7}
                  y={py(b[1]) - 7}
                  text={v.label}
                  fill={tone.color}
                  fontSize={10}
                  fontWeight={700}
                  halo={DEFAULTS.surface}
                />
              )}
            </g>
          );
        })}

        {/* Sweep line or ray */}
        {sweep && (
          <g stroke={activeColor} strokeWidth={2} strokeDasharray="4 3">
            {sweep.axis === "x" && <line x1={px(sweep.at)} y1={offY} x2={px(sweep.at)} y2={offY + drawH} />}
            {sweep.axis === "y" && <line x1={offX} y1={py(sweep.at)} x2={offX + drawW} y2={py(sweep.at)} />}
            {sweep.axis === "angle" &&
              (() => {
                const [ox, oy] = sweep.origin ?? [0, 0];
                const len = Math.hypot(drawW, drawH);
                const rad = (sweep.at * Math.PI) / 180;
                return (
                  <line
                    x1={px(ox)}
                    y1={py(oy)}
                    x2={px(ox) + Math.cos(rad) * len}
                    y2={py(oy) - Math.sin(rad) * len}
                  />
                );
              })()}
            {sweep.label && (
              <SvgLabel
                x={sweep.axis === "y" ? offX + 6 : px(sweep.at) + 6}
                y={sweep.axis === "y" ? py(sweep.at) - 6 : offY + 10}
                text={sweep.label}
                fill={activeColor}
                fontSize={10}
                fontWeight={700}
                halo={DEFAULTS.surface}
              />
            )}
          </g>
        )}

        {points.map((p, i) => {
          const id = idOf(p, "pt", i);
          const tone = toneOf(id, p.color);
          const x = px(p.x);
          const y = py(p.y);
          return (
            <g key={`pt${i}`} opacity={tone.opacity} style={{ transition: "opacity 0.25s ease" }}>
              {pointMarker(p, x, y, tone.color)}
              {p.label && (
                <SvgLabel
                  x={x + 7}
                  y={y - 7}
                  text={p.label}
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

        {labels.map((l, i) => {
          const at = resolve(l.at);
          if (!at) return null;
          return (
            <SvgLabel
              key={`lbl${i}`}
              x={px(at[0]) + (l.dx ?? 0)}
              y={py(at[1]) + (l.dy ?? 0)}
              text={l.text}
              anchor="middle"
              fill={l.color ?? DEFAULTS.text}
              fontSize={10}
              fontWeight={600}
              halo={DEFAULTS.surface}
            />
          );
        })}

        {xLabel && (
          <text
            x={offX + drawW / 2}
            y={height - 3}
            textAnchor="middle"
            fill={DEFAULTS.dimColor}
            fontSize={10}
            fontWeight={600}
          >
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text
            x={10}
            y={offY + drawH / 2}
            textAnchor="middle"
            transform={`rotate(-90 10 ${offY + drawH / 2})`}
            fill={DEFAULTS.dimColor}
            fontSize={10}
            fontWeight={600}
          >
            {yLabel}
          </text>
        )}
      </svg>
    </div>
  );
}
