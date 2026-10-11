import { beforeEach, describe, expect, it } from "vitest";
import { createElement, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { usePlayback, type PlaybackOptions, type PlaybackReturn } from "./usePlayback";
import { hasClock, nextAnonymousClockId, resetClocks } from "./playbackClock";

const STEPS = [
  { state: 0, label: "a" },
  { state: 1, label: "b" },
  { state: 2, label: "c" },
];

/** Render once, the way the first render of a mount sees the hook. */
function firstRender(opts?: PlaybackOptions | RefObject<HTMLElement | null>): PlaybackReturn<number> {
  let seen: PlaybackReturn<number> | null = null;
  function Probe() {
    seen = usePlayback(STEPS, opts);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return seen!;
}

describe("usePlayback's first render", () => {
  beforeEach(resetClocks);

  it("does not create a named clock from render", () => {
    const pb = firstRender({ clock: "shared" });
    expect(hasClock("shared")).toBe(false);
    expect(pb.totalSteps).toBe(3);
    expect(pb.currentStep).toBe(0);
  });

  it("does not burn an anonymous id from render", () => {
    firstRender();
    firstRender();
    expect(nextAnonymousClockId()).toBe("w1");
  });

  it("offers no step link for a playback that opted out of the page", () => {
    const pb = firstRender({ clock: null });
    expect(pb.controls.clockId).toBeUndefined();
    expect(nextAnonymousClockId()).toBe("w1");
  });

  it("still accepts a bare container ref", () => {
    const pb = firstRender({ current: null });
    expect(pb.current.label).toBe("a");
  });
});
