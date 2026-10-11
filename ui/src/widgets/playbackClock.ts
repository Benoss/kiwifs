/**
 * Page-scoped playback clocks.
 *
 * A clock is a step counter several widgets can share: a mermaid diagram, the
 * array it is describing, and the code listing all advance together, driven by
 * one scrubber. Widgets that do not name a clock get a private one, so a page
 * of unrelated animations behaves as it always did.
 *
 * The step also lives in the URL fragment, which is how a reader links to "the
 * moment the pointers cross". The first anonymous clock on a page with more
 * than one step owns the bare `#?step=N` key so links written before clocks
 * existed keep working; every other clock writes `#?step.<id>=N`. A heading
 * anchor in front of the query (`#intro?step=3`) is kept.
 *
 * The clock, not any one widget, runs the autoplay timer. Members only answer
 * "how long does step N last, and does it pause there?", so a short member
 * leaving or holding its last frame cannot stall a longer one.
 */

export interface ClockSnapshot {
  id: string;
  step: number;
  playing: boolean;
  speed: number;
  /** Longest member. Shorter members clamp to their own last step. */
  total: number;
  /** A member is waiting on the reader: autoplay and stepping forward hold. */
  blocked: boolean;
}

/**
 * `named` clocks are shared by name; `anonymous` ones are a widget's own but
 * still deep-linkable; `private` ones never touch the URL.
 */
export type ClockKind = "named" | "anonymous" | "private";

export interface StepTiming {
  duration?: number;
  breakpoint?: boolean;
}

export interface ClockMember {
  /** This member's step count. */
  total: number;
  /** Timing for one of this member's steps. */
  stepAt?: (step: number) => StepTiming | undefined;
  /** Default ms per step at 1x. The first member's wins. */
  interval?: number;
  /** Wrap at the end instead of stopping. The first member's wins. */
  loop?: boolean;
  blocked?: boolean;
}

type Listener = () => void;

interface Clock {
  id: string;
  kind: ClockKind;
  step: number;
  playing: boolean;
  speed: number;
  members: Map<object, ClockMember>;
  listeners: Set<Listener>;
  /** Cached immutable snapshot, so useSyncExternalStore sees a stable value. */
  snapshot: ClockSnapshot;
  /** Hash key this clock reads and writes; null until it has a second step. */
  hashKey: string | null;
  /** Set when the opening step came from the URL; consumed once, to scroll. */
  deepLinked: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** What the running timer was armed for, so unrelated refreshes leave it be. */
  timerKey: string;
}

const LEGACY_KEY = "step";
const DEFAULT_INTERVAL = 600;

const clocks = new Map<string, Clock>();
let anonymousCount = 0;
let privateCount = 0;
let anonymousIds = new WeakMap<object, string>();
let privateIds = new WeakMap<object, string>();
/** The clock holding the bare `step` key on this page. */
let legacyOwner: string | null = null;

// ── Hash plumbing ───────────────────────────────────────────────────────────

/** `#intro?step=3` → `{prefix: "intro", query: "step=3"}`. */
export function splitHash(hash: string): { prefix: string; query: string } {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = body.indexOf("?");
  return q >= 0 ? { prefix: body.slice(0, q), query: body.slice(q + 1) } : { prefix: body, query: "" };
}

/**
 * The inverse of `splitHash`. A superseded `#/path` route is dropped, the same
 * as `preservedUrlSuffix` does: it names a page, and after it a `?` would be
 * read as part of the path.
 */
export function joinHash(prefix: string, query: string): string {
  const keep = prefix.startsWith("/") ? "" : prefix;
  if (!keep && !query) return "";
  return `#${keep}${query ? `?${query}` : ""}`;
}

function hashParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(splitHash(window.location.hash).query);
}

export function readHashStep(key: string | null): number | null {
  if (!key) return null;
  const raw = hashParams().get(key);
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function withSteps(hash: string, entries: Iterable<[string, number]>): string {
  const { prefix, query } = splitHash(hash);
  const params = new URLSearchParams(query);
  for (const [key, value] of entries) {
    if (value <= 0) params.delete(key);
    else params.set(key, String(value));
  }
  return joinHash(prefix, params.toString());
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
/** The page a queued write belongs to; a navigation in between drops it. */
let writePath: string | null = null;
const writeQueue = new Map<string, number>();

/**
 * `replaceState`, never `pushState`: scrubbing through forty steps must not
 * bury the previous page under forty back-button presses.
 */
function flushHash() {
  writeTimer = null;
  if (typeof window === "undefined" || typeof history === "undefined") return;
  if (writeQueue.size === 0) return;
  const { pathname, search, hash } = window.location;
  if (writePath !== null && writePath !== pathname) {
    writeQueue.clear();
    return;
  }
  const nextHash = withSteps(hash, writeQueue);
  writeQueue.clear();
  if (nextHash === hash || (nextHash === "" && hash === "#")) return;
  try {
    history.replaceState(history.state, "", pathname + search + nextHash);
  } catch {
    // Sandboxed iframes reject history writes; the step still works in-page.
  }
}

function scheduleHashWrite(key: string | null, step: number) {
  if (!key || typeof window === "undefined") return;
  writePath = window.location.pathname;
  writeQueue.set(key, step);
  if (writeTimer != null) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushHash, 150);
}

/** An in-page `<a href="#?step=5">` moves the clock it names. */
function onHashChange() {
  for (const clock of [...clocks.values()]) {
    const step = readHashStep(clock.hashKey);
    if (step != null) seekClock(clock.id, step);
  }
}

let hashListening = false;
function listenForHashChanges() {
  if (hashListening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  hashListening = true;
  window.addEventListener("hashchange", onHashChange);
}

// ── Clock lifecycle ─────────────────────────────────────────────────────────

function totalOf(c: Clock): number {
  let max = 1;
  for (const m of c.members.values()) max = Math.max(max, m.total);
  return max;
}

function firstMember(c: Clock): ClockMember | undefined {
  return c.members.values().next().value;
}

function isBlocked(c: Clock): boolean {
  for (const m of c.members.values()) if (m.blocked) return true;
  return false;
}

function loops(c: Clock): boolean {
  return firstMember(c)?.loop ?? false;
}

/** The first member that has this step and says how long it lasts. */
function durationAt(c: Clock, step: number): number {
  for (const m of c.members.values()) {
    if (step >= m.total) continue;
    const d = m.stepAt?.(step)?.duration;
    if (d != null && Number.isFinite(d) && d >= 0) return d;
  }
  return firstMember(c)?.interval ?? DEFAULT_INTERVAL;
}

function breakpointAt(c: Clock, step: number): boolean {
  for (const m of c.members.values()) {
    if (step < m.total && m.stepAt?.(step)?.breakpoint) return true;
  }
  return false;
}

/**
 * A clock earns a URL key once it has somewhere to go. A one-frame figure that
 * claimed the bare `step` key would swallow every legacy link on the page.
 */
function adoptHashKey(c: Clock, total: number) {
  if (c.hashKey !== null || c.kind === "private" || total <= 1) return;
  if (c.kind === "anonymous" && legacyOwner === null) {
    legacyOwner = c.id;
    c.hashKey = LEGACY_KEY;
  } else {
    c.hashKey = `${LEGACY_KEY}.${c.id}`;
  }
  // A deep link is a deliberate act and outranks a remembered position.
  const fromHash = readHashStep(c.hashKey);
  const start = fromHash ?? persistence?.read(c.id);
  if (start != null) c.step = Math.max(0, Math.min(Math.round(start), total - 1));
  c.deepLinked = fromHash != null && c.step > 0;
}

function syncTimer(c: Clock, total: number) {
  if (c.members.size > 0 && c.playing && (isBlocked(c) || (!loops(c) && c.step >= total - 1))) {
    c.playing = false;
  }
  const armed = c.playing && c.members.size > 0;
  const key = armed ? `${c.step}|${c.speed}|${total}` : "";
  if (key === c.timerKey && (c.timer != null) === armed) return;
  if (c.timer != null) clearTimeout(c.timer);
  c.timer = null;
  c.timerKey = key;
  if (!armed) return;
  const ms = durationAt(c, c.step) / (c.speed > 0 ? c.speed : 1);
  c.timer = setTimeout(() => tick(c), ms);
}

function tick(c: Clock) {
  c.timer = null;
  c.timerKey = "";
  if (clocks.get(c.id) !== c || !c.playing) return;
  if (!isBlocked(c)) {
    const total = totalOf(c);
    c.step = c.step >= total - 1 ? 0 : c.step + 1;
    if (breakpointAt(c, c.step)) c.playing = false;
  }
  refresh(c);
}

function refresh(c: Clock) {
  const total = totalOf(c);
  // Between StrictMode's unmount and remount there are no members to clamp
  // against; the step must wait for them, not fall to zero.
  if (c.members.size === 0) {
    syncTimer(c, total);
    return;
  }
  if (c.step > total - 1) c.step = total - 1;
  adoptHashKey(c, total);
  syncTimer(c, total);
  const blocked = isBlocked(c);
  const prev = c.snapshot;
  if (
    prev.step === c.step &&
    prev.playing === c.playing &&
    prev.speed === c.speed &&
    prev.total === total &&
    prev.blocked === blocked
  ) {
    return;
  }
  c.snapshot = { id: c.id, step: c.step, playing: c.playing, speed: c.speed, total, blocked };
  for (const fn of [...c.listeners]) fn();
}

function create(id: string, kind: ClockKind): Clock {
  listenForHashChanges();
  const clock: Clock = {
    id,
    kind,
    step: 0,
    playing: false,
    speed: 1,
    members: new Map(),
    listeners: new Set(),
    hashKey: null,
    deepLinked: false,
    timer: null,
    timerKey: "",
    snapshot: { id, step: 0, playing: false, speed: 1, total: 1, blocked: false },
  };
  clocks.set(id, clock);
  return clock;
}

function kindOf(named: boolean | ClockKind): ClockKind {
  if (typeof named === "string") return named;
  return named ? "named" : "anonymous";
}

function ensure(id: string, named: boolean | ClockKind): Clock {
  return clocks.get(id) ?? create(id, kindOf(named));
}

function drop(c: Clock) {
  if (c.timer != null) clearTimeout(c.timer);
  c.timer = null;
  clocks.delete(c.id);
  if (legacyOwner === c.id) legacyOwner = null;
  // With nothing left on the page the next widget is the first again, so a
  // remount (closing the editor, say) hands out the same ids and keys.
  if (clocks.size === 0) {
    anonymousCount = 0;
    anonymousIds = new WeakMap();
  }
}

/**
 * Deletion waits a microtask: StrictMode unmounts and remounts every effect
 * synchronously, and the clock — its step, its URL key — must survive that.
 */
function releaseIfEmpty(c: Clock) {
  if (c.members.size > 0 || c.listeners.size > 0) return;
  queueMicrotask(() => {
    if (clocks.get(c.id) === c && c.members.size === 0 && c.listeners.size === 0) drop(c);
  });
}

/** An id for a widget that did not name its clock. Stable within a page. */
export function nextAnonymousClockId(): string {
  let id: string;
  do {
    anonymousCount += 1;
    id = `w${anonymousCount}`;
  } while (clocks.has(id));
  return id;
}

/** The anonymous clock id for one hook instance, allocated once per page. */
export function anonymousClockId(member: object): string {
  let id = anonymousIds.get(member);
  if (!id) {
    id = nextAnonymousClockId();
    anonymousIds.set(member, id);
  }
  return id;
}

/** A clock id that is never written to the URL and never shared. */
export function privateClockId(member: object): string {
  let id = privateIds.get(member);
  if (!id) {
    privateCount += 1;
    id = `~p${privateCount}`;
    privateIds.set(member, id);
  }
  return id;
}

/**
 * Register as a member of `id` (or update the registration). The clock's
 * total is the longest member's, so a four-step diagram beside a twelve-step
 * array holds its last frame rather than truncating the array.
 */
export function joinClock(
  id: string,
  named: boolean | ClockKind,
  member: object,
  spec: number | ClockMember,
): ClockSnapshot {
  const clock = ensure(id, named);
  const next: ClockMember = typeof spec === "number" ? { total: spec } : { ...spec };
  next.total = Math.max(1, Math.floor(next.total) || 1);
  clock.members.set(member, next);
  refresh(clock);
  return clock.snapshot;
}

export function leaveClock(id: string, member: object) {
  const clock = clocks.get(id);
  if (!clock || !clock.members.delete(member)) return;
  refresh(clock);
  releaseIfEmpty(clock);
}

export function subscribeClock(id: string, named: boolean | ClockKind, fn: Listener): () => void {
  const clock = ensure(id, named);
  clock.listeners.add(fn);
  return () => {
    clock.listeners.delete(fn);
    releaseIfEmpty(clock);
  };
}

const EMPTY: ClockSnapshot = { id: "", step: 0, playing: false, speed: 1, total: 1, blocked: false };

export function clockSnapshot(id: string): ClockSnapshot {
  return clocks.get(id)?.snapshot ?? EMPTY;
}

/** Whether a clock by this id exists on the page. */
export function hasClock(id: string): boolean {
  return clocks.has(id);
}

/** The URL key a clock reads and writes, or null if it has none. */
export function clockHashKey(id: string): string | null {
  return clocks.get(id)?.hashKey ?? null;
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

/** One step forward or back. Forward is refused while a member is blocked. */
export function stepClock(id: string, delta: number, opts: SeekOptions = {}) {
  const clock = clocks.get(id);
  if (!clock) return;
  if (delta > 0 && isBlocked(clock)) return;
  seekClock(id, clock.step + delta, opts);
}

/** Start autoplay, rewinding first if a non-looping clock sits at its end. */
export function playClock(id: string) {
  const clock = clocks.get(id);
  if (!clock || isBlocked(clock)) return;
  if (!loops(clock) && clock.step >= totalOf(clock) - 1) seekClock(id, 0, { persist: true });
  setClockPlaying(id, true);
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
  const { origin, pathname, search, hash } = window.location;
  const entries: [string, number][] = clock?.hashKey ? [[clock.hashKey, clock.step]] : [];
  return `${origin}${pathname}${search}${withSteps(hash, entries)}`;
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

/**
 * Forget every clock, the anonymous counter and any pending URL write. A page
 * navigation calls this; the workspace's persistence setting survives it.
 */
export function resetClocks() {
  for (const clock of clocks.values()) {
    if (clock.timer != null) clearTimeout(clock.timer);
    clock.timer = null;
  }
  clocks.clear();
  anonymousCount = 0;
  anonymousIds = new WeakMap();
  privateIds = new WeakMap();
  legacyOwner = null;
  writeQueue.clear();
  writePath = null;
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

/** Test seam: what an in-page link to `#?step=N` does. */
export function handleClockHashChange() {
  onHashChange();
}
