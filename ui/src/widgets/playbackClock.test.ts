import { beforeEach, describe, expect, it } from "vitest";
import {
  clockSnapshot,
  clockStepLink,
  consumeDeepLink,
  flushClockHash,
  isClockDriver,
  joinClock,
  leaveClock,
  nextAnonymousClockId,
  readHashStep,
  resetClocks,
  seekClock,
  setClockPlaying,
  setClockSpeed,
  subscribeClock,
} from "./playbackClock";

const A = {};
const B = {};

function setHash(hash: string) {
  // jsdom is not configured for these tests; a stub location is enough for the
  // hash parsing and writing we care about.
  const url = new URL("https://example.test/page/notes.md" + hash);
  (globalThis as Record<string, unknown>).window = {
    location: {
      hash: url.hash,
      pathname: url.pathname,
      search: url.search,
      origin: url.origin,
    },
  };
  (globalThis as Record<string, unknown>).history = {
    state: null,
    replaceState: (_s: unknown, _t: string, next: string) => {
      const u = new URL(next, url.origin);
      const w = (globalThis as Record<string, any>).window;
      w.location.hash = u.hash;
      w.location.pathname = u.pathname;
      w.location.search = u.search;
    },
  };
}

describe("playbackClock", () => {
  beforeEach(() => {
    resetClocks();
    setHash("");
  });

  it("gives each anonymous widget its own clock", () => {
    const one = nextAnonymousClockId();
    joinClock(one, false, A, 5);
    const two = nextAnonymousClockId();
    joinClock(two, false, B, 5);

    expect(one).not.toBe(two);
    seekClock(one, 3);
    expect(clockSnapshot(one).step).toBe(3);
    expect(clockSnapshot(two).step).toBe(0);
  });

  it("locksteps two members of a named clock", () => {
    joinClock("a", true, A, 4);
    joinClock("a", true, B, 4);
    seekClock("a", 2);
    expect(clockSnapshot("a").step).toBe(2);
  });

  it("takes its total from the longest member and clamps the step", () => {
    joinClock("a", true, A, 3);
    joinClock("a", true, B, 9);
    expect(clockSnapshot("a").total).toBe(9);

    seekClock("a", 8);
    expect(clockSnapshot("a").step).toBe(8);

    // The long member leaves; the step cannot survive past the short one's end.
    leaveClock("a", B);
    expect(clockSnapshot("a").total).toBe(3);
    expect(clockSnapshot("a").step).toBe(2);
  });

  it("elects one driver, and re-elects when it leaves", () => {
    joinClock("a", true, A, 4);
    joinClock("a", true, B, 4);
    expect(isClockDriver("a", A)).toBe(true);
    expect(isClockDriver("a", B)).toBe(false);

    leaveClock("a", A);
    expect(isClockDriver("a", B)).toBe(true);
  });

  it("notifies subscribers and hands out a stable snapshot", () => {
    joinClock("a", true, A, 4);
    let seen = 0;
    const off = subscribeClock("a", true, () => {
      seen += 1;
    });
    const before = clockSnapshot("a");
    expect(clockSnapshot("a")).toBe(before);

    seekClock("a", 1);
    expect(seen).toBe(1);
    expect(clockSnapshot("a")).not.toBe(before);

    // A seek to the step it is already on must not wake React again.
    seekClock("a", 1);
    expect(seen).toBe(1);
    off();
  });

  it("tracks playing and speed", () => {
    joinClock("a", true, A, 4);
    setClockPlaying("a", true);
    setClockSpeed("a", 4);
    expect(clockSnapshot("a").playing).toBe(true);
    expect(clockSnapshot("a").speed).toBe(4);
  });

  describe("the URL fragment", () => {
    it("reads the legacy bare key for the first anonymous clock", () => {
      setHash("#?step=3");
      const id = nextAnonymousClockId();
      joinClock(id, false, A, 8);
      expect(clockSnapshot(id).step).toBe(3);
      expect(consumeDeepLink(id)).toBe(true);
      expect(consumeDeepLink(id)).toBe(false);
    });

    it("gives the second anonymous clock its own key, not the bare one", () => {
      setHash("#?step=3");
      const first = nextAnonymousClockId();
      joinClock(first, false, A, 8);
      const second = nextAnonymousClockId();
      joinClock(second, false, B, 8);
      expect(clockSnapshot(second).step).toBe(0);
    });

    it("reads a named clock from step.<id>", () => {
      setHash("#?step.a=4&step.b=2");
      joinClock("a", true, A, 9);
      joinClock("b", true, B, 9);
      expect(clockSnapshot("a").step).toBe(4);
      expect(clockSnapshot("b").step).toBe(2);
    });

    it("clamps a deep link past the end", () => {
      setHash("#?step.a=99");
      joinClock("a", true, A, 3);
      expect(clockSnapshot("a").step).toBe(2);
    });

    it("writes only on a reader's change, never on an autoplay tick", () => {
      joinClock("a", true, A, 9);
      seekClock("a", 4);
      flushClockHash();
      expect(readHashStep("step.a")).toBe(null);

      seekClock("a", 5, { persist: true });
      flushClockHash();
      expect(readHashStep("step.a")).toBe(5);
    });

    it("drops the key at step zero instead of writing step=0", () => {
      setHash("#?step.a=4");
      joinClock("a", true, A, 9);
      seekClock("a", 0, { persist: true });
      flushClockHash();
      expect(readHashStep("step.a")).toBe(null);
    });

    it("keeps other clocks' keys when one of them moves", () => {
      setHash("#?step.a=1&step.b=7");
      joinClock("a", true, A, 9);
      joinClock("b", true, B, 9);
      seekClock("a", 3, { persist: true });
      flushClockHash();
      expect(readHashStep("step.a")).toBe(3);
      expect(readHashStep("step.b")).toBe(7);
    });

    it("builds a shareable link for the current step", () => {
      joinClock("a", true, A, 9);
      seekClock("a", 6);
      expect(clockStepLink("a")).toBe("https://example.test/page/notes.md#?step.a=6");
    });
  });
});
