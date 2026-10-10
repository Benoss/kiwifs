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

/** Display text for a primitive. */
export function formatValue(value: TraceValue): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value) && value[0] === "SPECIAL_FLOAT") return String(value[1]);
  return String(value);
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
export function describeHeapObject(id: HeapId, raw: HeapObject): HeapEntry {
  const kind = String(raw[0] ?? "OBJECT");
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
        slots: raw.slice(1).map((pair) => {
          const [key, value] = pair as readonly [TraceValue, TraceValue];
          return { label: formatValue(key), value };
        }),
      };
    case "INSTANCE":
      return {
        id,
        kind,
        title: String(raw[1] ?? ""),
        slots: raw.slice(2).map((pair) => {
          const [field, value] = pair as readonly [string, TraceValue];
          return { label: field, value };
        }),
      };
    case "CLASS":
    case "FUNCTION":
      return { id, kind, title: String(raw[1] ?? ""), slots: [] };
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

  for (const frame of frames) {
    for (const key of frameOrder(frame)) push(frame.vars[key]);
    push(frame.returned);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const raw = heap[String(id)];
    if (!raw) continue;
    out.push(id);
    for (const slot of describeHeapObject(id, raw).slots) push(slot.value);
  }

  // Anything unreachable still has to be drawn — an author stepping through a
  // leak wants to see the object nothing points at.
  for (const id of Object.keys(heap)) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** A frame's variables, honouring an explicit `order`. */
export function frameOrder(frame: StackFrame): string[] {
  const keys = Object.keys(frame.vars);
  if (!frame.order) return keys;
  const named = frame.order.filter((k) => k in frame.vars);
  return [...named, ...keys.filter((k) => !named.includes(k))];
}

/** Stable key for the arrow from a frame variable to its heap object. */
export function slotKey(scope: string, name: string): string {
  return `${scope}.${name}`;
}
