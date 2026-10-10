/**
 * Greedy lane packing, shared by TimelineView and NumberLineView.
 *
 * Both have the same problem — overlapping spans must not draw on top of each
 * other — and solving it twice would let the two drift apart visually.
 */

export interface Span {
  start: number;
  end: number;
  /** Pre-assigned lane; respected as-is. */
  lane?: number;
}

/**
 * Lane per span: the first one whose last span ends at or before this one
 * starts. Spans that declare a lane keep it, and still block that lane for
 * everyone else.
 */
export function assignLanes(spans: readonly Span[]): number[] {
  const laneEnds: number[] = [];
  const out: number[] = [];

  spans.forEach((span, i) => {
    if (span.lane != null && Number.isFinite(span.lane)) {
      const lane = Math.max(0, Math.trunc(span.lane));
      // Fill the skipped lanes rather than leaving holes: a hole reads as
      // `undefined` to the search below, and `undefined <= start` is false,
      // so lane 0 would stay unusable for everyone else.
      while (laneEnds.length <= lane) laneEnds.push(-Infinity);
      out[i] = lane;
      laneEnds[lane] = Math.max(laneEnds[lane]!, span.end);
      return;
    }
    let lane = laneEnds.findIndex((end) => end <= span.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = span.end;
    out[i] = lane;
  });

  return out;
}

/** Highest lane index in use, so a caller can size its canvas. */
export function laneCount(lanes: readonly number[]): number {
  return lanes.length === 0 ? 1 : Math.max(...lanes) + 1;
}
