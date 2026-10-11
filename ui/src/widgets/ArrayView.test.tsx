import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArrayStack, ArrayView, cellEditHandlers } from "./ArrayView";
import { InspectContext, type InspectState } from "./inspect";

function bus(over: Partial<InspectState> = {}): InspectState {
  return {
    selected: null,
    hovered: null,
    select: () => {},
    hover: () => {},
    why: {},
    linkedKeys: () => new Set(),
    links: [],
    ...over,
  };
}

function withBus(state: InspectState, node: React.ReactElement) {
  return renderToStaticMarkup(<InspectContext.Provider value={state}>{node}</InspectContext.Provider>);
}

const selecting = (widget: string, key: string) =>
  bus({
    selected: { widget, kind: "cell", key },
    linkedKeys: (w) => (w === widget ? new Set([key]) : new Set()),
  });

describe("ArrayStack inspect keys", () => {
  it("lights only the selected row's cell in a stack", () => {
    const html = withBus(
      selecting("array", "1:2"),
      <ArrayStack rows={[{ values: [1, 2, 3] }, { values: [4, 5, 6] }]} onSelect={() => {}} />,
    );
    expect([...html.matchAll(/outline:2px solid/g)]).toHaveLength(1);
    expect([...html.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  });

  it("keeps plain index keys on a single ArrayView", () => {
    const html = withBus(selecting("array", "2"), <ArrayView values={[1, 2, 3]} onSelect={() => {}} />);
    expect([...html.matchAll(/outline:2px solid/g)]).toHaveLength(1);
    expect(html).toContain('aria-selected="true"');
  });
});

function fakeCell(text: string) {
  const el = {
    textContent: text,
    dataset: {} as DOMStringMap,
    blur: () => handlers.onBlur({ currentTarget: el }),
  };
  let handlers: ReturnType<typeof cellEditHandlers>;
  return {
    el,
    bind(h: ReturnType<typeof cellEditHandlers>) {
      handlers = h;
      return h;
    },
  };
}

const key = (k: string, el: ReturnType<typeof fakeCell>["el"]) => ({
  key: k,
  currentTarget: el,
  preventDefault: () => {},
  stopPropagation: () => {},
});

describe("cellEditHandlers", () => {
  it("commits a changed value on Enter", () => {
    const commit = vi.fn();
    const cell = fakeCell("7");
    const h = cell.bind(cellEditHandlers("7", commit));
    cell.el.textContent = "9";
    h.onKeyDown(key("Enter", cell.el));
    expect(commit).toHaveBeenCalledExactlyOnceWith("9");
  });

  it("does not commit an unchanged value on blur", () => {
    const commit = vi.fn();
    const cell = fakeCell("7");
    const h = cell.bind(cellEditHandlers("7", commit));
    h.onBlur({ currentTarget: cell.el });
    expect(commit).not.toHaveBeenCalled();
  });

  it("reverts and commits nothing on Escape", () => {
    const commit = vi.fn();
    const cell = fakeCell("7");
    const h = cell.bind(cellEditHandlers("7", commit));
    cell.el.textContent = "100";
    h.onKeyDown(key("Escape", cell.el));
    expect(commit).not.toHaveBeenCalled();
    expect(cell.el.textContent).toBe("7");
    cell.el.textContent = "8";
    h.onBlur({ currentTarget: cell.el });
    expect(commit).toHaveBeenCalledExactlyOnceWith("8");
  });
});
