import { describe, expect, it, vi } from "vitest";

// Each component is called as a plain function with every hook stubbed and
// counted, so the count is that component's own hooks — children are only
// returned as elements, never rendered. A hook after an early return shows up
// as a different count for the empty and the populated input, which is the
// crash React reports when data arrives on a later render.
const calls = vi.hoisted(() => ({ count: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const count = () => {
    calls.count++;
  };
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => {
      count();
      return [typeof init === "function" ? (init as () => T)() : init, () => {}];
    },
    useReducer: <S,>(_r: unknown, init: S) => {
      count();
      return [init, () => {}];
    },
    useRef: <T,>(init: T) => {
      count();
      return { current: init };
    },
    useEffect: count,
    useLayoutEffect: count,
    useInsertionEffect: count,
    useMemo: <T,>(f: () => T) => {
      count();
      return f();
    },
    useCallback: <T,>(f: T) => {
      count();
      return f;
    },
    useId: () => {
      count();
      return ":r0:";
    },
    useContext: <T,>(ctx: { _currentValue: T }) => {
      count();
      return ctx._currentValue;
    },
    useSyncExternalStore: <T,>(_s: unknown, get: () => T) => {
      count();
      return get();
    },
  };
});

import { MatrixView } from "./MatrixView";
import { PlotView } from "./PlotView";
import { TreeView } from "./TreeView";

function hooks<P>(component: (props: P) => unknown, props: P): number {
  calls.count = 0;
  component(props);
  return calls.count;
}

describe("no hook after an early return", () => {
  it("TreeView", () => {
    expect(hooks(TreeView, { root: null })).toBe(hooks(TreeView, { fromArray: [1, 2, 3] }));
  });

  it("MatrixView", () => {
    expect(hooks(MatrixView, { values: [] })).toBe(hooks(MatrixView, { values: [[1, 2], [3, 4]] }));
  });

  it("PlotView", () => {
    expect(hooks(PlotView, { series: [] })).toBe(
      hooks(PlotView, { series: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] }),
    );
  });
});
