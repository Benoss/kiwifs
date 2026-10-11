/**
 * The Python Tutor trace format, as data.
 *
 * MemoryView's props deliberately mirror `opt-trace-format`: frames on the
 * left, a heap of tagged objects on the right, and `["REF", id]` wherever a
 * value is a pointer. An author writes the steps by hand today; a tracer could
 * drive the same widget tomorrow without an API change, which is the whole
 * reason not to invent a nicer-looking shape.
 *
 * Spec: Python Tutor `opt-trace-format.md` (original repo gone; mirror at
 * `zetaloop/OnlinePythonTutor-Backup`). `dodona-json-tracer` emits the same.
 */

import { shortText } from "./widgetA11y";

export type HeapId = string | number;

/** A primitive, or a pointer into the heap. */
export type TraceValue =
  | string
  | number
  | boolean
  | null
  | readonly ["REF", HeapId]
  | readonly ["SPECIAL_FLOAT", string];

export interface StackFrame {
  /** Function name, e.g. `fib`. */
  name: string;
  /** Identity across steps. Defaults to `name` plus its position. */
  id?: string;
  /** Locals, in the order given. */
  vars: Record<string, TraceValue>;
  /** Explicit variable order, when object key order is not what you mean. */
  order?: string[];
  /** Marks the frame that is executing. `activeFrame` on the view wins. */
  active?: boolean;
  /** The return value, once there is one. */
  returned?: TraceValue;
}

/**
 * A heap object, tagged by kind. The tag is the first element, exactly as the
 * trace format has it, so a recorded trace drops straight in.
 */
export type HeapObject =
  | readonly ["LIST", ...TraceValue[]]
  | readonly ["TUPLE", ...TraceValue[]]
  | readonly ["SET", ...TraceValue[]]
  | readonly ["DICT", ...(readonly [TraceValue, TraceValue])[]]
  | readonly ["INSTANCE", string, ...(readonly [string, TraceValue])[]]
  | readonly ["CLASS", string, ...unknown[]]
  | readonly ["FUNCTION", string, ...unknown[]]
  | readonly ["REF", HeapId]
  | readonly [string, ...unknown[]];

export function isRef(value: unknown): value is readonly ["REF", HeapId] {
  return Array.isArray(value) && value[0] === "REF" && value.length >= 2;
}

export function refTarget(value: unknown): HeapId | null {
  return isRef(value) ? value[1] : null;
}

/** Display text for a primitive; anything else reads as truncated JSON. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value) && value[0] === "SPECIAL_FLOAT") return String(value[1]);
  if (typeof value === "object") return shortText(value);
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPair(value: unknown): value is readonly [unknown, unknown] {
  return Array.isArray(value) && value.length >= 2;
}

/** A frame's locals, or none when the author left `vars` out. */
export function varsOf(frame: StackFrame): Record<string, TraceValue> {
  return isRecord(frame.vars) ? (frame.vars as Record<string, TraceValue>) : {};
}

/** The heap object with this id, ignoring anything inherited from `Object.prototype`. */
export function heapGet(heap: Record<string, HeapObject>, id: HeapId): HeapObject | undefined {
  if (!isRecord(heap)) return undefined;
  const key = String(id);
  return Object.prototype.hasOwnProperty.call(heap, key) ? heap[key] : undefined;
}

export interface HeapEntry {
  id: HeapId;
  kind: string;
  /** Row-per-element: an index for a list, a key for a dict, a field for an instance. */
  slots: { label?: string; value: TraceValue }[];
  /** Class name for an INSTANCE, function name for a FUNCTION. */
  title?: string;
}

/** Normalise a tagged heap object into rows a renderer can lay out. */
export function describeHeapObject(id: HeapId, raw: HeapObject | unknown): HeapEntry {
  if (!Array.isArray(raw)) {
    // Not the tagged format: a plain `{field: value}` reads as an object's
    // fields, and a bare primitive as a box holding it.
    if (isRecord(raw)) {
      return { id, kind: "OBJECT", slots: Object.entries(raw).map(([label, value]) => ({ label, value: value as TraceValue })) };
    }
    return { id, kind: "OBJECT", slots: raw === undefined ? [] : [{ value: raw as TraceValue }] };
  }
  const kind = typeof raw[0] === "string" ? raw[0] : "OBJECT";
  switch (kind) {
    case "LIST":
    case "TUPLE":
      return {
        id,
        kind,
        slots: raw.slice(1).map((value, i) => ({ label: String(i), value: value as TraceValue })),
      };
    case "SET":
      return { id, kind, slots: raw.slice(1).map((value) => ({ value: value as TraceValue })) };
    case "DICT":
      return {
        id,
        kind,
        slots: raw
          .slice(1)
          .filter(isPair)
          .map(([key, value]) => ({ label: formatValue(key), value: value as TraceValue })),
      };
    case "INSTANCE":
      return {
        id,
        kind,
        title: shortText(raw[1] ?? ""),
        slots: raw
          .slice(2)
          .filter(isPair)
          .map(([field, value]) => ({ label: shortText(field), value: value as TraceValue })),
      };
    case "CLASS":
    case "FUNCTION":
      return { id, kind, title: shortText(raw[1] ?? ""), slots: [] };
    default:
      return {
        id,
        kind,
        slots: raw.slice(1).map((value, i) => ({ label: String(i), value: value as TraceValue })),
      };
  }
}

/**
 * Heap ids in the order a reader meets them: breadth-first from the frames.
 *
 * Python Tutor's ordering, and the reason its diagrams stay readable as a
 * structure grows — a newly allocated object appears below the one that points
 * at it rather than jumping to the top.
 */
export function heapOrder(
  frames: readonly StackFrame[],
  heap: Record<string, HeapObject>,
): HeapId[] {
  const seen = new Set<string>();
  const out: HeapId[] = [];
  const queue: HeapId[] = [];

  const push = (value: TraceValue | undefined) => {
    const target = refTarget(value);
    if (target == null || seen.has(String(target))) return;
    seen.add(String(target));
    queue.push(target);
  };

  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!isRecord(frame as unknown)) continue;
    const vars = varsOf(frame);
    for (const key of frameOrder(frame)) push(vars[key]);
    push(frame.returned);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const raw = heapGet(heap, id);
    if (raw === undefined) continue;
    out.push(id);
    for (const slot of describeHeapObject(id, raw).slots) push(slot.value);
  }

  // Anything unreachable still has to be drawn — an author stepping through a
  // leak wants to see the object nothing points at.
  for (const id of isRecord(heap) ? Object.keys(heap) : []) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** A frame's variables, honouring an explicit `order`. */
export function frameOrder(frame: StackFrame): string[] {
  const vars = varsOf(frame);
  const keys = Object.keys(vars);
  if (!Array.isArray(frame.order)) return keys;
  const named = frame.order.map(String).filter((k) => Object.prototype.hasOwnProperty.call(vars, k));
  return [...new Set(named), ...keys.filter((k) => !named.includes(k))];
}

/** Stable key for the arrow from a frame variable to its heap object. */
export function slotKey(scope: string, name: string): string {
  return `${scope}.${name}`;
}
