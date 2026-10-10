import { useRef, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { ensureRootTracking, keyBelongsTo, partHasFocus, useWidgetRoot } from "./widgetRoot";
import {
  clockSnapshot,
  consumeDeepLink,
  isClockDriver,
  joinClock,
  leaveClock,
  nextAnonymousClockId,
  seekClock,
  setClockPlaying,
  setClockSpeed,
  subscribeClock,
} from "./playbackClock";
import { useClockId } from "./clockContext";

export interface Step<T> {
  state: T;
  label: string;
  /** If true, auto-play pauses when reaching this step. */
  breakpoint?: boolean;
  /** How long auto-play lingers on this step at 1x, in ms. */
  duration?: number;
}

export interface PlaybackControlsBinding {
  currentStep: number;
  totalSteps: number;
  playing: boolean;
  speed: number;
  onPlay: () => void;
  onStop: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onReset: () => void;
  onSeek: (step: number) => void;
  onCycleSpeed: () => void;
  /** Identifies the clock for "copy link to this step". */
  clockId?: string;
}

export interface PlaybackReturn<T> {
  current: Step<T>;
  currentStep: number;
  totalSteps: number;
  playing: boolean;
  speed: number;
  play: () => void;
  stop: () => void;
  stepForward: () => void;
  stepBack: () => void;
  reset: () => void;
  setSpeed: (speed: number) => void;
  setCurrentStep: (step: number) => void;
  /** Cycle through speed presets: 1 → 2 → 4 → 1 */
  cycleSpeed: () => void;
  /** The clock this playback is driven by. */
  clockId: string;
  /** Spread into PlaybackControls, or pass the whole object as `pb`. */
  controls: PlaybackControlsBinding;
}

export interface PlaybackOptions {
  /** Ref scoping keyboard events. Defaults to the enclosing widget. */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Default ms per step at 1x. Defaults to 600. */
  interval?: number;
  /** Start playing on mount. */
  autoPlay?: boolean;
  /** Wrap to the first step instead of stopping at the end. */
  loop?: boolean;
  /**
   * Share a step counter with every other playback naming the same clock, and
   * persist it as `#?step.<id>=N`. Without one, this playback gets a private
   * clock, as it always had.
   */
  clock?: string;
}

const SPEED_PRESETS = [1, 2, 4];
const EMPTY_STEP: Step<never> = { state: {} as never, label: "" };

/**
 * A step written flat as `{ ...fields, label }` keeps its fields on
 * `current` and also exposes itself as `current.state`.
 */
function normalizeStep<T>(raw: unknown): Step<T> {
  if (raw && typeof raw === "object" && "state" in raw) return raw as Step<T>;
  if (raw && typeof raw === "object") {
    const flat = raw as Record<string, unknown>;
    return { ...flat, state: raw as T, label: flat.label == null ? "" : String(flat.label) } as Step<T>;
  }
  return { state: raw as T, label: "" };
}

function isRef(v: unknown): v is React.RefObject<HTMLElement | null> {
  return typeof v === "object" && v !== null && "current" in v && Object.keys(v).length === 1;
}

export function usePlayback<T>(
  steps: Step<T>[],
  /** A container ref (legacy) or options. */
  arg?: React.RefObject<HTMLElement | null> | PlaybackOptions,
): PlaybackReturn<T> {
  const opts: PlaybackOptions = isRef(arg) ? { containerRef: arg } : (arg ?? {});
  const { containerRef, interval = 600, autoPlay = false, loop = false } = opts;
  const list = Array.isArray(steps) ? steps : [];
  const total = Math.max(1, list.length);
  const widgetRoot = useWidgetRoot();
  const inheritedClock = useClockId();

  // One token per hook instance: the clock's member identity, and the key it
  // uses to decide which member runs the autoplay timer.
  const member = useRef<object>({});
  const idRef = useRef<{ id: string; named: boolean } | null>(null);
  if (!idRef.current) {
    const named = opts.clock ?? inheritedClock;
    idRef.current = named
      ? { id: named, named: true }
      : { id: nextAnonymousClockId(), named: false };
  }
  const { id: clockId, named } = idRef.current;

  // Register before the first subscribe so the clock knows its length (and
  // therefore clamps a deep-linked step) on the very first render.
  joinClock(clockId, named, member.current, total);

  const subscribe = useCallback(
    (fn: () => void) => subscribeClock(clockId, named, fn),
    [clockId, named],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => clockSnapshot(clockId),
    () => clockSnapshot(clockId),
  );

  useEffect(() => {
    const token = member.current;
    joinClock(clockId, named, token, total);
    return () => leaveClock(clockId, token);
  }, [clockId, named, total]);

  const currentStep = Math.max(0, Math.min(snapshot.step, total - 1));
  const clockTotal = Math.max(total, snapshot.total);
  const playing = snapshot.playing;
  const speed = snapshot.speed;

  const stop = useCallback(() => setClockPlaying(clockId, false), [clockId]);
  const play = useCallback(() => {
    if (!loop && clockSnapshot(clockId).step >= clockSnapshot(clockId).total - 1) {
      seekClock(clockId, 0, { persist: true });
    }
    setClockPlaying(clockId, true);
  }, [clockId, loop]);

  const stepForward = useCallback(() => {
    seekClock(clockId, clockSnapshot(clockId).step + 1, { persist: true });
  }, [clockId]);

  const stepBack = useCallback(() => {
    seekClock(clockId, clockSnapshot(clockId).step - 1, { persist: true });
  }, [clockId]);

  const reset = useCallback(() => {
    setClockPlaying(clockId, false);
    seekClock(clockId, 0, { persist: true });
  }, [clockId]);

  const seek = useCallback(
    (s: number) => seekClock(clockId, s, { persist: true }),
    [clockId],
  );

  const setSpeed = useCallback((s: number) => setClockSpeed(clockId, s), [clockId]);

  const cycleSpeed = useCallback(() => {
    const idx = SPEED_PRESETS.indexOf(clockSnapshot(clockId).speed);
    setClockSpeed(clockId, SPEED_PRESETS[(idx + 1) % SPEED_PRESETS.length]!);
  }, [clockId]);

  const current = useMemo(
    () => (list.length ? normalizeStep<T>(list[Math.min(currentStep, list.length - 1)]) : (EMPTY_STEP as Step<T>)),
    [list, currentStep],
  );

  useEffect(() => {
    if (autoPlay) setClockPlaying(clockId, true);
  }, [autoPlay, clockId]);

  /** Scroll a deep-linked widget into view once, so the link lands on it. */
  useEffect(() => {
    if (!consumeDeepLink(clockId)) return;
    const el = containerRef?.current ?? widgetRoot?.current;
    if (!el) return;
    const timer = setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("kiwi-widget-flash");
      setTimeout(() => el.classList.remove("kiwi-widget-flash"), 1200);
    }, 120);
    return () => clearTimeout(timer);
  }, [clockId, containerRef, widgetRoot]);

  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    if (!playing) return;
    if (!isClockDriver(clockId, member.current)) return;
    if (currentStep >= clockTotal - 1 && !loop) {
      setClockPlaying(clockId, false);
      return;
    }
    const here = normalizeStep<T>(listRef.current[currentStep]);
    const ms = (here.duration ?? interval) / speed;
    const timer = setTimeout(() => {
      const next = currentStep >= clockTotal - 1 ? 0 : currentStep + 1;
      seekClock(clockId, next);
      if (normalizeStep(listRef.current[next]).breakpoint) setClockPlaying(clockId, false);
    }, ms);
    return () => clearTimeout(timer);
  }, [playing, currentStep, clockTotal, loop, interval, speed, clockId]);

  useEffect(() => {
    ensureRootTracking();
    const scoped = containerRef?.current;
    const target: EventTarget = scoped ?? document;
    const handler = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.defaultPrevented || ke.metaKey || ke.ctrlKey || ke.altKey) return;
      const el = ke.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (!scoped && widgetRoot?.current && !keyBelongsTo(widgetRoot.current, ke.target)) return;

      switch (ke.key) {
        case " ":
          if (tag === "BUTTON") return;
          ke.preventDefault();
          setClockPlaying(clockId, !clockSnapshot(clockId).playing);
          break;
        case "ArrowRight":
        case "ArrowLeft": {
          // A focused cell owns the arrows; it is moving the reader's cursor,
          // not the clock.
          const root = widgetRoot?.current;
          if (root && partHasFocus(root, ke.target)) return;
          ke.preventDefault();
          setClockPlaying(clockId, false);
          if (ke.key === "ArrowRight") stepForward();
          else stepBack();
          break;
        }
        case "r":
          ke.preventDefault();
          reset();
          break;
      }
    };
    target.addEventListener("keydown", handler);
    return () => target.removeEventListener("keydown", handler);
  }, [containerRef, widgetRoot, clockId, stepForward, stepBack, reset]);

  const controls = useMemo<PlaybackControlsBinding>(() => ({
    currentStep,
    totalSteps: clockTotal,
    playing,
    speed,
    onPlay: play,
    onStop: stop,
    onStepForward: stepForward,
    onStepBack: stepBack,
    onReset: reset,
    onSeek: seek,
    onCycleSpeed: cycleSpeed,
    clockId,
  }), [currentStep, clockTotal, playing, speed, play, stop, stepForward, stepBack, reset, seek, cycleSpeed, clockId]);

  return {
    current,
    currentStep,
    totalSteps: clockTotal,
    playing,
    speed,
    play,
    stop,
    stepForward,
    stepBack,
    reset,
    setSpeed,
    setCurrentStep: seek,
    cycleSpeed,
    clockId,
    controls,
  };
}
