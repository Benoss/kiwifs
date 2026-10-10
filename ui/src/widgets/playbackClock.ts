/**
 * Page-scoped playback clocks.
 *
 * A clock is a step counter several widgets can share: a mermaid diagram, the
 * array it is describing, and the code listing all advance together, driven by
 * one scrubber. Widgets that do not name a clock get a private one, so a page
 * of unrelated animations behaves as it always did.
 *
 * The step also lives in the URL fragment, which is how a reader links to "the
 * moment the pointers cross". The first anonymous clock on a page owns the bare
 * `#?step=N` key so links written before clocks existed keep working; every
 * other clock writes `#?step.<id>=N`.
 */

export interface ClockSnapshot {
  id: string;
  step: number;
  playing: boolean;
  speed: number;
  /** Longest member. Shorter members clamp to their own last step. */
  total: number;
}

type Listener = () => void;

interface Clock {
  id: string;
  step: number;
  playing: boolean;
  speed: number;
  /** member token → that member's step count. */
  members: Map<object, number>;
  listeners: Set<Listener>;
  /** Cached immutable snapshot, so useSyncExternalStore sees a stable value. */
  snapshot: ClockSnapshot;
  /** Hash key this clock reads and writes, or null for "do not persist". */
  hashKey: string | null;
  /** Set when the opening step came from the URL; consumed once, to scroll. */
  deepLinked: boolean;
  /**
   * The member that runs the autoplay timer. Without an elected driver, two
   * widgets sharing a clock would each advance it and play at double speed.
   */
  driver: object | null;
}

const LEGACY_KEY = "step";

const clocks = new Map<string, Clock>();
let anonymousCount = 0;

// ── Hash plumbing ───────────────────────────────────────────────────────────

/** The `a=1&b=2` part of a `#?a=1&b=2` fragment. */
function hashParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  const hash = window.location.hash;
  const q = hash.indexOf("?");
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : "");
}

export function readHashStep(key: string | null): number | null {
  if (!key) return null;
  const raw = hashParams().get(key);
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
const writeQueue = new Map<string, number>();

/**
 * `replaceState`, never `pushState`: scrubbing through forty steps must not
 * bury the previous page under forty back-button presses.
 */
function flushHash() {
  writeTimer = null;
  if (typeof window === "undefined" || typeof history === "undefined") return;
  if (writeQueue.size === 0) return;
  const params = hashParams();
  for (const [key, value] of writeQueue) {
    if (value <= 0) params.delete(key);
    else params.set(key, String(value));
  }
  writeQueue.clear();
  const query = params.toString();
  const next = window.location.pathname + window.location.search + (query ? `#?${query}` : "");
  try {
    history.replaceState(history.state, "", next);
  } catch {
    // Sandboxed iframes reject history writes; the step still works in-page.
  }
}

function scheduleHashWrite(key: string | null, step: number) {
  if (!key || typeof window === "undefined") return;
  writeQueue.set(key, step);
  if (writeTimer != null) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushHash, 150);
}

// ── Clock lifecycle ─────────────────────────────────────────────────────────

function totalOf(c: Clock): number {
  let max = 1;
  for (const t of c.members.values()) max = Math.max(max, t);
  return max;
}

function refresh(c: Clock) {
  const total = totalOf(c);
  if (c.step > total - 1) c.step = total - 1;
  c.snapshot = { id: c.id, step: c.step, playing: c.playing, speed: c.speed, total };
  for (const fn of c.listeners) fn();
}

function create(id: string, named: boolean): Clock {
  // The bare `step` key belongs to the first anonymous clock on the page.
  const hashKey = !named && anonymousCount === 0 ? LEGACY_KEY : `${LEGACY_KEY}.${id}`;
  if (!named) anonymousCount += 1;
  // A deep link is a deliberate act and outranks a remembered position.
  const fromHash = readHashStep(hashKey);
  const step = fromHash ?? persistence?.read(id) ?? 0;
  const clock: Clock = {
    id,
    step,
    playing: false,
    speed: 1,
    members: new Map(),
    listeners: new Set(),
    hashKey,
    deepLinked: fromHash != null && fromHash > 0,
    driver: null,
    snapshot: { id, step, playing: false, speed: 1, total: 1 },
  };
  clocks.set(id, clock);
  return clock;
}

function ensure(id: string, named: boolean): Clock {
  return clocks.get(id) ?? create(id, named);
}

/** An id for a widget that did not name its clock. Stable within a page load. */
export function nextAnonymousClockId(): string {
  let n = anonymousCount + 1;
  while (clocks.has(`w${n}`)) n += 1;
  return `w${n}`;
}

/**
 * Register as a member of `id`, contributing `total` steps. The clock's total
 * is the longest member's, so a four-step diagram beside a twelve-step array
 * holds its last frame rather than truncating the array.
 */
export function joinClock(id: string, named: boolean, member: object, total: number): ClockSnapshot {
  const clock = ensure(id, named);
  const want = Math.max(1, total);
  if (clock.driver === null) clock.driver = member;
  if (clock.members.get(member) !== want) {
    clock.members.set(member, want);
    refresh(clock);
  }
  return clock.snapshot;
}

export function leaveClock(id: string, member: object) {
  const clock = clocks.get(id);
  if (!clock) return;
  clock.members.delete(member);
  if (clock.driver === member) {
    clock.driver = clock.members.keys().next().value ?? null;
  }
  if (clock.members.size === 0 && clock.listeners.size === 0) {
    clocks.delete(id);
    return;
  }
  refresh(clock);
}

export function subscribeClock(id: string, named: boolean, fn: Listener): () => void {
  const clock = ensure(id, named);
  clock.listeners.add(fn);
  return () => {
    clock.listeners.delete(fn);
    if (clock.members.size === 0 && clock.listeners.size === 0) clocks.delete(clock.id);
  };
}

/** Whether this member runs the autoplay timer for its clock. */
export function isClockDriver(id: string, member: object): boolean {
  const clock = clocks.get(id);
  return clock ? clock.driver === member : false;
}

const EMPTY: ClockSnapshot = { id: "", step: 0, playing: false, speed: 1, total: 1 };

export function clockSnapshot(id: string): ClockSnapshot {
  return clocks.get(id)?.snapshot ?? EMPTY;
}

/**
 * True once, for the widget that should scroll itself into view because the
 * reader arrived on a `#?step=` link.
 */
export function consumeDeepLink(id: string): boolean {
  const clock = clocks.get(id);
  if (!clock?.deepLinked) return false;
  clock.deepLinked = false;
  return true;
}

// ── Mutations ───────────────────────────────────────────────────────────────

export interface SeekOptions {
  /** Autoplay ticks leave the URL alone; a reader's click persists. */
  persist?: boolean;
}

export function seekClock(id: string, step: number, opts: SeekOptions = {}) {
  const clock = clocks.get(id);
  if (!clock) return;
  const total = totalOf(clock);
  const next = Math.max(0, Math.min(Math.round(step), total - 1));
  if (opts.persist) scheduleHashWrite(clock.hashKey, next);
  if (next === clock.step) return;
  clock.step = next;
  if (opts.persist) persistence?.write(clock.id, next);
  refresh(clock);
}

export function setClockPlaying(id: string, playing: boolean) {
  const clock = clocks.get(id);
  if (!clock || clock.playing === playing) return;
  clock.playing = playing;
  refresh(clock);
}

export function setClockSpeed(id: string, speed: number) {
  const clock = clocks.get(id);
  if (!clock || clock.speed === speed) return;
  clock.speed = speed;
  refresh(clock);
}

/** The shareable URL for this clock's current step. */
export function clockStepLink(id: string): string {
  if (typeof window === "undefined") return "";
  const clock = clocks.get(id);
  const params = hashParams();
  const key = clock?.hashKey ?? LEGACY_KEY;
  const step = clock?.step ?? 0;
  if (step <= 0) params.delete(key);
  else params.set(key, String(step));
  const query = params.toString();
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}${query ? `#?${query}` : ""}`;
}

// ── Optional per-page persistence ───────────────────────────────────────────

/**
 * Where to remember the last step per clock, and a reader of that record.
 *
 * Off by default, and deliberately: a reader returning to a page should see
 * the author's opening frame, not whatever they happened to leave it on.
 * A workspace that wants resume behaviour supplies the two callbacks.
 */
export interface ClockPersistence {
  read: (id: string) => number | undefined;
  write: (id: string, step: number) => void;
}

let persistence: ClockPersistence | null = null;

export function setClockPersistence(p: ClockPersistence | null) {
  persistence = p;
}

/** Test seam: forget every clock and the anonymous counter. */
export function resetClocks() {
  clocks.clear();
  anonymousCount = 0;
  persistence = null;
  writeQueue.clear();
  if (writeTimer != null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

/** Test seam: flush the debounced hash write now. */
export function flushClockHash() {
  if (writeTimer != null) clearTimeout(writeTimer);
  flushHash();
}
