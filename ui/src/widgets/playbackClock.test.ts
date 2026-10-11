import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anonymousClockId,
  clockHashKey,
  clockSnapshot,
  clockStepLink,
  consumeDeepLink,
  flushClockHash,
  handleClockHashChange,
  hasClock,
  joinClock,
  joinHash,
  leaveClock,
  nextAnonymousClockId,
  playClock,
  privateClockId,
  readHashStep,
  resetClocks,
  seekClock,
  setClockPersistence,
  setClockPlaying,
  setClockSpeed,
  splitHash,
  stepClock,
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
    setClockPersistence(null);
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

  describe("the URL fragment keeps what is not ours", () => {
    it("splits and rejoins a heading anchor and a query", () => {
      expect(splitHash("#intro?step=3")).toEqual({ prefix: "intro", query: "step=3" });
      expect(splitHash("#intro")).toEqual({ prefix: "intro", query: "" });
      expect(splitHash("")).toEqual({ prefix: "", query: "" });
      expect(joinHash("intro", "step=3")).toBe("#intro?step=3");
      expect(joinHash("intro", "")).toBe("#intro");
      expect(joinHash("", "")).toBe("");
      expect(joinHash("/notes/a.md", "step=3")).toBe("#?step=3");
    });

    it("writes behind a heading anchor and leaves the anchor at step zero", () => {
      setHash("#intro");
      joinClock("a", true, A, 9);
      seekClock("a", 3, { persist: true });
      flushClockHash();
      expect(window.location.hash).toBe("#intro?step.a=3");
      seekClock("a", 0, { persist: true });
      flushClockHash();
      expect(window.location.hash).toBe("#intro");
    });

    it("removes the fragment entirely when nothing is left in it", () => {
      setHash("#?step.a=2");
      joinClock("a", true, A, 9);
      seekClock("a", 0, { persist: true });
      flushClockHash();
      expect(window.location.hash).toBe("");
    });

    it("reads a step written behind a heading anchor", () => {
      setHash("#the-loop?step=3");
      const id = nextAnonymousClockId();
      joinClock(id, false, A, 8);
      expect(clockSnapshot(id).step).toBe(3);
    });

    it("drops a superseded #/path route rather than appending to it", () => {
      setHash("#/notes/a.md");
      joinClock("a", true, A, 9);
      seekClock("a", 3, { persist: true });
      flushClockHash();
      expect(window.location.hash).toBe("#?step.a=3");
    });

    it("drops a queued write once the reader has moved to another page", () => {
      joinClock("a", true, A, 9);
      seekClock("a", 3, { persist: true });
      (window as unknown as { location: { pathname: string } }).location.pathname = "/page/other.md";
      flushClockHash();
      expect(window.location.hash).toBe("");
    });

    it("keeps the anchor in a shareable link", () => {
      setHash("#intro");
      joinClock("a", true, A, 9);
      seekClock("a", 2);
      expect(clockStepLink("a")).toBe("https://example.test/page/notes.md#intro?step.a=2");
    });

    it("follows an in-page link to another step", () => {
      setHash("#?step.a=1");
      joinClock("a", true, A, 9);
      window.location.hash = "#?step.a=5";
      handleClockHashChange();
      expect(clockSnapshot("a").step).toBe(5);
      // A plain heading link says nothing about the clock.
      window.location.hash = "#intro";
      handleClockHashChange();
      expect(clockSnapshot("a").step).toBe(5);
    });
  });

  describe("figures with nothing to play", () => {
    it("does not give a one-frame clock the legacy key", () => {
      setHash("#?step=3");
      const still = nextAnonymousClockId();
      joinClock(still, false, A, 1);
      const stepped = nextAnonymousClockId();
      joinClock(stepped, false, B, 8);
      expect(clockHashKey(still)).toBe(null);
      expect(clockHashKey(stepped)).toBe("step");
      expect(clockSnapshot(stepped).step).toBe(3);
      expect(consumeDeepLink(still)).toBe(false);
    });

    it("claims a key once a second member gives the clock somewhere to go", () => {
      setHash("#?step.a=2");
      joinClock("a", true, A, 1);
      expect(clockHashKey("a")).toBe(null);
      joinClock("a", true, B, 5);
      expect(clockHashKey("a")).toBe("step.a");
      expect(clockSnapshot("a").step).toBe(2);
    });

    it("decides deep-linked after clamping", () => {
      setHash("#?step.a=0");
      joinClock("a", true, A, 4);
      expect(consumeDeepLink("a")).toBe(false);

      resetClocks();
      setHash("#?step.b=99");
      joinClock("b", true, A, 3);
      expect(clockSnapshot("b").step).toBe(2);
      expect(consumeDeepLink("b")).toBe(true);
    });

    it("never gives a private clock a URL key", () => {
      setHash("#?step=3");
      const id = privateClockId(A);
      expect(privateClockId(A)).toBe(id);
      joinClock(id, "private", A, 8);
      expect(clockHashKey(id)).toBe(null);
      expect(clockSnapshot(id).step).toBe(0);
      seekClock(id, 4, { persist: true });
      flushClockHash();
      expect(window.location.hash).toBe("#?step=3");
      // The legacy key is still free for the page's first stepped widget.
      const first = anonymousClockId(B);
      joinClock(first, "anonymous", B, 8);
      expect(clockSnapshot(first).step).toBe(3);
    });
  });

  describe("StrictMode and unmounting", () => {
    it("survives an unmount and remount in the same tick", async () => {
      setHash("#?step=4");
      const id = anonymousClockId(A);
      joinClock(id, "anonymous", A, 8);
      const off = subscribeClock(id, "anonymous", () => {});
      seekClock(id, 6);

      leaveClock(id, A);
      off();
      expect(anonymousClockId(A)).toBe(id);
      joinClock(id, "anonymous", A, 8);
      const off2 = subscribeClock(id, "anonymous", () => {});
      await Promise.resolve();

      expect(hasClock(id)).toBe(true);
      expect(clockSnapshot(id).step).toBe(6);
      expect(clockHashKey(id)).toBe("step");
      off2();
    });

    it("forgets a clock after a real unmount, and numbering starts over", async () => {
      const id = anonymousClockId(A);
      joinClock(id, "anonymous", A, 8);
      const off = subscribeClock(id, "anonymous", () => {});
      leaveClock(id, A);
      off();
      await Promise.resolve();
      expect(hasClock(id)).toBe(false);
      expect(anonymousClockId(B)).toBe(id);
    });
  });

  describe("page navigation", () => {
    it("restarts anonymous numbering so the legacy key goes to the new page's first widget", () => {
      joinClock(anonymousClockId(A), "anonymous", A, 5);
      joinClock(anonymousClockId(B), "anonymous", B, 5);
      resetClocks();
      setHash("#?step=4");
      const C = {};
      const id = anonymousClockId(C);
      joinClock(id, "anonymous", C, 8);
      expect(id).toBe("w1");
      expect(clockHashKey(id)).toBe("step");
      expect(clockSnapshot(id).step).toBe(4);
    });

    it("cancels a pending hash write", () => {
      joinClock("a", true, A, 9);
      seekClock("a", 3, { persist: true });
      resetClocks();
      flushClockHash();
      expect(window.location.hash).toBe("");
    });

    it("ignores the old page's late cleanup", () => {
      joinClock("w1", "anonymous", A, 3);
      resetClocks();
      joinClock("w1", "anonymous", B, 7);
      leaveClock("w1", A);
      expect(clockSnapshot("w1").total).toBe(7);
    });
  });

  describe("autoplay", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("plays to the longest member's end even when the first member is shorter", () => {
      joinClock("a", true, A, 3);
      joinClock("a", true, B, 6);
      playClock("a");
      vi.advanceTimersByTime(600 * 5);
      expect(clockSnapshot("a").step).toBe(5);
      expect(clockSnapshot("a").playing).toBe(false);
    });

    it("advances once per tick with several members", () => {
      joinClock("a", true, A, 6);
      joinClock("a", true, B, 6);
      playClock("a");
      vi.advanceTimersByTime(600);
      expect(clockSnapshot("a").step).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
    });

    it("keeps playing when the first member unmounts mid-play", () => {
      joinClock("a", true, A, 6);
      joinClock("a", true, B, 6);
      playClock("a");
      vi.advanceTimersByTime(600);
      leaveClock("a", A);
      vi.advanceTimersByTime(600);
      expect(clockSnapshot("a").step).toBe(2);
    });

    it("stops its timer when no members remain", () => {
      joinClock("a", true, A, 6);
      playClock("a");
      leaveClock("a", A);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(clockSnapshot("a").step).toBe(0);
    });

    it("asks the member that has the step how long it lasts", () => {
      joinClock("a", true, A, { total: 2, interval: 1000 });
      joinClock("a", true, B, { total: 4, stepAt: (i) => (i === 2 ? { duration: 50 } : undefined) });
      seekClock("a", 2);
      playClock("a");
      vi.advanceTimersByTime(50);
      expect(clockSnapshot("a").step).toBe(3);
    });

    it("pauses on a breakpoint any member declares", () => {
      joinClock("a", true, A, 5);
      joinClock("a", true, B, { total: 5, stepAt: (i) => (i === 2 ? { breakpoint: true } : undefined) });
      playClock("a");
      vi.advanceTimersByTime(600 * 4);
      expect(clockSnapshot("a").step).toBe(2);
      expect(clockSnapshot("a").playing).toBe(false);
    });

    it("loops when the first member asks to", () => {
      joinClock("a", true, A, { total: 3, loop: true });
      playClock("a");
      vi.advanceTimersByTime(600 * 3);
      expect(clockSnapshot("a").step).toBe(0);
      expect(clockSnapshot("a").playing).toBe(true);
    });

    it("rewinds a finished clock when play is pressed", () => {
      joinClock("a", true, A, 3);
      seekClock("a", 2);
      playClock("a");
      expect(clockSnapshot("a").step).toBe(0);
      expect(clockSnapshot("a").playing).toBe(true);
    });

    it("forgets every timer on navigation", () => {
      joinClock("a", true, A, 6);
      playClock("a");
      resetClocks();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("blocked", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("pauses autoplay when a member blocks mid-play", () => {
      joinClock("a", true, A, 6);
      playClock("a");
      vi.advanceTimersByTime(600);
      joinClock("a", true, A, { total: 6, blocked: true });
      expect(clockSnapshot("a").playing).toBe(false);
      expect(clockSnapshot("a").blocked).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(clockSnapshot("a").step).toBe(1);
    });

    it("refuses to play or step forward, but steps back, seeks and resets", () => {
      joinClock("a", true, A, { total: 6, blocked: true });
      seekClock("a", 3);
      playClock("a");
      expect(clockSnapshot("a").playing).toBe(false);
      stepClock("a", 1);
      expect(clockSnapshot("a").step).toBe(3);
      stepClock("a", -1);
      expect(clockSnapshot("a").step).toBe(2);
      seekClock("a", 4);
      expect(clockSnapshot("a").step).toBe(4);
      seekClock("a", 0);
      expect(clockSnapshot("a").step).toBe(0);
    });

    it("holds a shared clock while any member is blocked", () => {
      joinClock("a", true, A, 6);
      joinClock("a", true, B, { total: 6, blocked: true });
      stepClock("a", 1);
      expect(clockSnapshot("a").step).toBe(0);
      joinClock("a", true, B, { total: 6, blocked: false });
      stepClock("a", 1);
      expect(clockSnapshot("a").step).toBe(1);
    });
  });
});
