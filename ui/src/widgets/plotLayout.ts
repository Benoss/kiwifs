/**
 * Domain, ticks, and polyline helpers for PlotView.
 *
 * Kept out of the React component so the geometry is unit-testable and so a
 * stepping animation can precompute frames without the SVG layer.
 */

import { compile } from "@kw/lib/expr";

export interface PlotPoint {
  x: number;
  y: number;
}

export interface PlotSeriesInput {
  id?: string | number;
  points?: PlotPoint[];
  baseline?: number;
}

export interface PlotShadeInput {
  from: number;
  to: number;
  fromY?: number;
  toY?: number;
}

export interface PlotGuideInput {
  x?: number;
  y?: number;
}

export interface PlotMarkInput {
  x: number;
  y?: number;
}

export interface PlotDomain {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

function finiteNumbers(values: number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

/** Expand a degenerate min===max range so a scale still has somewhere to go. */
export function expandRange(min: number, max: number): { min: number; max: number } {
  if (min < max) return { min, max };
  if (min === 0) return { min: -1, max: 1 };
  const pad = Math.abs(min) || 1;
  return { min: min - pad, max: max + pad };
}

export function niceNum(span: number, round: boolean): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const exp = Math.floor(Math.log10(span));
  const frac = span / 10 ** exp;
  let nice: number;
  if (round) {
    if (frac < 1.5) nice = 1;
    else if (frac < 3) nice = 2;
    else if (frac < 7) nice = 5;
    else nice = 10;
  } else if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * 10 ** exp;
}

function roundTo(step: number, value: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const factor = 10 ** Math.min(decimals, 8);
  return Math.round(value * factor) / factor;
}

/** Evenly spaced "nice" ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const range = expandRange(min, max);
  const span = niceNum(range.max - range.min, false);
  const step = niceNum(span / Math.max(1, count - 1), true);
  const start = Math.floor(range.min / step) * step;
  const end = Math.ceil(range.max / step) * step;
  const ticks: number[] = [];
  const limit = end + step * 0.5;
  for (let v = start, i = 0; v <= limit && i < 24; v += step, i++) {
    ticks.push(roundTo(step, v));
  }
  return ticks;
}

export function yAt(points: PlotPoint[], x: number): number | null {
  if (!points.length) return null;
  const sorted = points.slice().sort((a, b) => a.x - b.x);
  if (x <= sorted[0]!.x) return sorted[0]!.y;
  if (x >= sorted[sorted.length - 1]!.x) return sorted[sorted.length - 1]!.y;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (x <= b.x) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return null;
}

/** Points of a polyline clipped to [x0, x1], with interpolated endpoints. */
export function slicePoints(points: PlotPoint[], x0: number, x1: number): PlotPoint[] {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const sorted = points.slice().sort((a, b) => a.x - b.x);
  if (sorted.length === 0) return [];
  const out: PlotPoint[] = [];
  const yLo = yAt(sorted, lo);
  const yHi = yAt(sorted, hi);
  if (yLo != null) out.push({ x: lo, y: yLo });
  for (const p of sorted) {
    if (p.x > lo && p.x < hi) out.push(p);
  }
  if (yHi != null) out.push({ x: hi, y: yHi });
  return out;
}

export function plotDomain(
  series: PlotSeriesInput[],
  extras: {
    shades?: PlotShadeInput[];
    guides?: PlotGuideInput[];
    marks?: PlotMarkInput[];
    xMin?: number;
    xMax?: number;
    yMin?: number;
    yMax?: number;
    pad?: number;
  } = {},
): PlotDomain {
  const xs: number[] = [];
  const ys: number[] = [];

  for (const s of series) {
    for (const p of s.points ?? []) {
      xs.push(p.x);
      ys.push(p.y);
    }
    if (s.baseline != null) ys.push(s.baseline);
  }
  for (const sh of extras.shades ?? []) {
    xs.push(sh.from, sh.to);
    if (sh.fromY != null) ys.push(sh.fromY);
    if (sh.toY != null) ys.push(sh.toY);
  }
  for (const g of extras.guides ?? []) {
    if (g.x != null) xs.push(g.x);
    if (g.y != null) ys.push(g.y);
  }
  for (const m of extras.marks ?? []) {
    xs.push(m.x);
    if (m.y != null) ys.push(m.y);
  }

  const fx = finiteNumbers(xs);
  const fy = finiteNumbers(ys);
  let xMin = extras.xMin ?? (fx.length ? Math.min(...fx) : 0);
  let xMax = extras.xMax ?? (fx.length ? Math.max(...fx) : 1);
  let yMin = extras.yMin ?? (fy.length ? Math.min(...fy) : 0);
  let yMax = extras.yMax ?? (fy.length ? Math.max(...fy) : 1);

  const xRange = expandRange(xMin, xMax);
  const yRange = expandRange(yMin, yMax);
  xMin = xRange.min;
  xMax = xRange.max;
  yMin = yRange.min;
  yMax = yRange.max;

  const pad = extras.pad ?? 0.05;
  if (extras.xMin == null || extras.xMax == null) {
    const dx = (xMax - xMin) * pad;
    if (extras.xMin == null) xMin -= dx;
    if (extras.xMax == null) xMax += dx;
  }
  if (extras.yMin == null || extras.yMax == null) {
    const dy = (yMax - yMin) * pad;
    if (extras.yMin == null) yMin -= dy;
    if (extras.yMax == null) yMax += dy;
  }

  return { xMin, xMax, yMin, yMax };
}

// ── Formula series and predicate regions ────────────────────────────────────

export interface SampledSeries<T> {
  series: T[];
  /** One message per series whose `expr` could not be parsed. */
  exprErrors: string[];
}

export interface SampleBounds {
  xMin?: number;
  xMax?: number;
}

/**
 * Turn `expr` series into point series.
 *
 * Done here rather than in the component so the domain, ticks and legend all
 * see ordinary points, and so this stays unit-testable. A series whose formula
 * is broken is dropped with a message rather than taking the chart down.
 */
export function sampleSeries<T extends { points?: PlotPoint[]; expr?: string; samples?: number; domain?: [number, number]; label?: string; id?: string | number }>(
  series: readonly T[],
  scope: Record<string, number> | undefined,
  bounds: SampleBounds = {},
): SampledSeries<T> {
  const exprErrors: string[] = [];
  // A formula needs an x range. Prefer the author's, else the extent of any
  // point series on the chart, else a conventional 0..10.
  const explicit = series.flatMap((s) => s.points ?? []).map((p) => p.x);
  const lo = bounds.xMin ?? (explicit.length ? Math.min(...explicit) : 0);
  const hi = bounds.xMax ?? (explicit.length ? Math.max(...explicit) : 10);

  const out: T[] = [];
  for (const s of series) {
    if (!s.expr) {
      out.push(s);
      continue;
    }
    const [from, to] = s.domain ?? [lo, hi];
    const n = Math.max(2, Math.min(2000, s.samples ?? 160));
    let f: (vars?: Record<string, number | boolean>) => number;
    try {
      f = compile(s.expr);
    } catch (err) {
      exprErrors.push(`${s.label ?? s.id ?? s.expr}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const points: PlotPoint[] = [];
    for (let i = 0; i < n; i++) {
      const x = from + ((to - from) * i) / (n - 1);
      let y: number;
      try {
        y = f({ ...scope, x });
      } catch (err) {
        exprErrors.push(`${s.label ?? s.id ?? s.expr}: ${err instanceof Error ? err.message : String(err)}`);
        points.length = 0;
        break;
      }
      // A pole (tan, 1/x) breaks the line rather than spiking it off-canvas.
      if (Number.isFinite(y)) points.push({ x, y });
    }
    if (points.length > 0) out.push({ ...s, points });
  }
  return { series: out, exprErrors };
}

export interface RegionCell {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Grid cells where a predicate holds, as rectangles in data space.
 *
 * Marching squares would give a smooth boundary; a grid is honest about being
 * a sample, cheap, and good enough to say "this is the feasible half".
 */
export function sampleRegion(
  when: string,
  domain: PlotDomain,
  scope: Record<string, number> | undefined,
  resolution = 48,
): { cells: RegionCell[]; error?: string } {
  let f: (vars?: Record<string, number | boolean>) => number;
  try {
    f = compile(when);
  } catch (err) {
    return { cells: [], error: err instanceof Error ? err.message : String(err) };
  }
  const n = Math.max(4, Math.min(200, resolution));
  const dx = (domain.xMax - domain.xMin) / n;
  const dy = (domain.yMax - domain.yMin) / n;
  const cells: RegionCell[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = domain.xMin + i * dx;
    // Merge horizontally adjacent cells into one rect per run, so a half-plane
    // is a handful of rectangles instead of 2304 of them.
    let runStart: number | null = null;
    for (let j = 0; j <= n; j++) {
      const y0 = domain.yMin + j * dy;
      let on = false;
      if (j < n) {
        try {
          on = f({ ...scope, x: x0 + dx / 2, y: y0 + dy / 2 }) !== 0;
        } catch (err) {
          return { cells: [], error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (on && runStart === null) runStart = y0;
      if (!on && runStart !== null) {
        cells.push({ x0, x1: x0 + dx, y0: runStart, y1: y0 });
        runStart = null;
      }
    }
  }
  return { cells };
}
