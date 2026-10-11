import { describe, expect, it } from "vitest";
import {
  describeHeapObject,
  formatValue,
  frameOrder,
  heapOrder,
  isRef,
  refTarget,
  slotKey,
  type HeapObject,
  type StackFrame,
  type TraceValue,
} from "./memoryTrace";

describe("refs", () => {
  it("recognises a pointer", () => {
    expect(isRef(["REF", 1])).toBe(true);
    expect(isRef(["LIST", 1])).toBe(false);
    expect(isRef(3)).toBe(false);
    expect(isRef(null)).toBe(false);
  });

  it("reads the target", () => {
    expect(refTarget(["REF", "a"])).toBe("a");
    expect(refTarget(7)).toBeNull();
  });
});

describe("formatValue", () => {
  it("uses Python's spellings, since the format is Python Tutor's", () => {
    expect(formatValue(null)).toBe("None");
    expect(formatValue(true)).toBe("True");
    expect(formatValue(false)).toBe("False");
  });

  it("quotes a string, so 1 and \"1\" are distinguishable", () => {
    expect(formatValue("hi")).toBe('"hi"');
    expect(formatValue("1")).toBe('"1"');
    expect(formatValue(1)).toBe("1");
  });

  it("passes a special float through", () => {
    expect(formatValue(["SPECIAL_FLOAT", "Infinity"])).toBe("Infinity");
  });
});

describe("describeHeapObject", () => {
  it("indexes a list", () => {
    const got = describeHeapObject(1, ["LIST", 10, 20]);
    expect(got.kind).toBe("LIST");
    expect(got.slots).toEqual([
      { label: "0", value: 10 },
      { label: "1", value: 20 },
    ]);
  });

  it("labels a dict by its keys", () => {
    const got = describeHeapObject(1, ["DICT", ["a", 1], ["b", 2]]);
    expect(got.slots.map((s) => s.label)).toEqual(['"a"', '"b"']);
    expect(got.slots.map((s) => s.value)).toEqual([1, 2]);
  });

  it("names an instance's class and fields", () => {
    const got = describeHeapObject(1, ["INSTANCE", "Node", ["val", 5], ["next", ["REF", 2]]]);
    expect(got.title).toBe("Node");
    expect(got.slots.map((s) => s.label)).toEqual(["val", "next"]);
  });

  it("leaves a set's elements unlabelled, because they have no index", () => {
    const got = describeHeapObject(1, ["SET", 1, 2]);
    expect(got.slots.every((s) => s.label === undefined)).toBe(true);
  });

  it("names a function or class without slots", () => {
    expect(describeHeapObject(1, ["FUNCTION", "fib"]).title).toBe("fib");
    expect(describeHeapObject(1, ["CLASS", "Node"]).slots).toEqual([]);
  });

  it("falls back to indexing an unknown tag", () => {
    const got = describeHeapObject(1, ["DEQUE", 1, 2] as HeapObject);
    expect(got.kind).toBe("DEQUE");
    expect(got.slots).toHaveLength(2);
  });
});

describe("frameOrder", () => {
  it("defaults to object key order", () => {
    expect(frameOrder({ name: "f", vars: { a: 1, b: 2 } })).toEqual(["a", "b"]);
  });

  it("honours an explicit order and appends the rest", () => {
    expect(frameOrder({ name: "f", vars: { a: 1, b: 2, c: 3 }, order: ["c", "a"] })).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("ignores an order entry with no such variable", () => {
    expect(frameOrder({ name: "f", vars: { a: 1 }, order: ["z", "a"] })).toEqual(["a"]);
  });
});

describe("heapOrder", () => {
  const heap: Record<string, HeapObject> = {
    1: ["LIST", ["REF", 2], ["REF", 3]],
    2: ["INSTANCE", "Node", ["val", 1]],
    3: ["INSTANCE", "Node", ["val", 2]],
    9: ["LIST", 42],
  };
  const frames: StackFrame[] = [{ name: "main", vars: { root: ["REF", 1] } }];

  it("walks breadth-first from the frames, so new objects appear below", () => {
    expect(heapOrder(frames, heap).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("still draws an unreachable object, which is the point when showing a leak", () => {
    expect(heapOrder(frames, heap)).toContain("9");
  });

  it("follows a return value", () => {
    const order = heapOrder([{ name: "f", vars: {}, returned: ["REF", 2] }], heap);
    expect(order[0]).toBe(2);
  });

  it("does not loop on a cycle", () => {
    const cyclic: Record<string, HeapObject> = {
      1: ["INSTANCE", "Node", ["next", ["REF", 2]]],
      2: ["INSTANCE", "Node", ["next", ["REF", 1]]],
    };
    expect(heapOrder([{ name: "f", vars: { a: ["REF", 1] } }], cyclic)).toEqual([1, 2]);
  });

  it("visits an aliased object once", () => {
    const order = heapOrder([{ name: "f", vars: { a: ["REF", 1], b: ["REF", 1] } }], { 1: ["LIST", 1] });
    expect(order).toEqual([1]);
  });

  it("skips a dangling reference instead of crashing", () => {
    expect(heapOrder([{ name: "f", vars: { a: ["REF", 404] } }], {})).toEqual([]);
  });
});

describe("malformed traces", () => {
  it("treats a frame with no vars as having no locals", () => {
    const frame = { name: "f" } as unknown as StackFrame;
    expect(frameOrder(frame)).toEqual([]);
    expect(heapOrder([frame], { 1: ["LIST"] })).toEqual(["1"]);
  });

  it("ignores an order that is not a list", () => {
    const frame = { name: "f", vars: { a: 1, b: 2 }, order: "b" } as unknown as StackFrame;
    expect(frameOrder(frame)).toEqual(["a", "b"]);
  });

  it("does not list a variable twice when order repeats it", () => {
    expect(frameOrder({ name: "f", vars: { a: 1, b: 2 }, order: ["b", "b"] })).toEqual(["b", "a"]);
  });

  it("skips dict and instance entries that are not pairs", () => {
    const dict = describeHeapObject(1, ["DICT", ["a", 1], "junk", ["b"], null, ["c", 3]] as unknown as HeapObject);
    expect(dict.slots.map((s) => s.label)).toEqual(['"a"', '"c"']);
    const inst = describeHeapObject(1, ["INSTANCE", "Node", 7, ["val", 5]] as unknown as HeapObject);
    expect(inst.slots).toEqual([{ label: "val", value: 5 }]);
  });

  it("draws an untagged object as fields and a bare value as one slot", () => {
    const obj = describeHeapObject(1, { val: 1, next: ["REF", 2] } as unknown as HeapObject);
    expect(obj.kind).toBe("OBJECT");
    expect(obj.slots.map((s) => s.label)).toEqual(["val", "next"]);
    expect(describeHeapObject(2, 42 as unknown as HeapObject).slots).toEqual([{ value: 42 }]);
  });

  it("follows a pointer out of an untagged object", () => {
    const heap = { 1: { next: ["REF", 2] }, 2: ["LIST", 1] } as unknown as Record<string, HeapObject>;
    expect(heapOrder([{ name: "f", vars: { a: ["REF", 1] } }], heap)).toEqual([1, 2]);
  });

  it("does not resolve a reference through Object.prototype", () => {
    expect(heapOrder([{ name: "f", vars: { a: ["REF", "constructor"] } }], {})).toEqual([]);
  });

  it("formats an inline structure as JSON rather than [object Object]", () => {
    expect(formatValue(["LIST", 1, 2] as unknown as TraceValue)).toBe('["LIST",1,2]');
    expect(formatValue({ a: 1 } as unknown as TraceValue)).toBe('{"a":1}');
  });
});

describe("slotKey", () => {
  it("scopes a variable to its frame, so two frames' `i` are distinct", () => {
    expect(slotKey("fib#0", "i")).toBe("fib#0.i");
    expect(slotKey("fib#1", "i")).not.toBe(slotKey("fib#0", "i"));
  });
});
