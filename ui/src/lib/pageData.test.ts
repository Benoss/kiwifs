import { beforeEach, describe, expect, it } from "vitest";
import { getPageData, pageDataVersion, registerPageData, resetPageData, unregisterPageData } from "./pageData";

const rows = (n: number) => [{ id: n }];

describe("pageData", () => {
  beforeEach(resetPageData);

  it("lets two blocks of one kind come and go without unregistering each other", () => {
    const first = {};
    const second = {};
    const a = rows(1);
    const b = rows(2);
    registerPageData("task", a, ["id"], first);
    registerPageData("task", b, ["id"], second);
    expect(getPageData("task")!.records).toBe(b);

    unregisterPageData("task", first);
    expect(getPageData("task")!.records).toBe(b);

    unregisterPageData("task", second);
    expect(getPageData("task")).toBeUndefined();
  });

  it("falls back to the remaining block when the latest one leaves", () => {
    const first = {};
    const second = {};
    const a = rows(1);
    registerPageData("task", a, ["id"], first);
    registerPageData("task", rows(2), ["id"], second);
    unregisterPageData("task", second);
    expect(getPageData("task")!.records).toBe(a);
  });

  it("updates a block's own registration in place", () => {
    const owner = {};
    registerPageData("task", rows(1), ["id"], owner);
    const next = rows(3);
    registerPageData("task", next, ["id"], owner);
    expect(getPageData("task")!.records).toBe(next);
    unregisterPageData("task", owner);
    expect(getPageData("task")).toBeUndefined();
  });

  it("does not wake readers for an identical registration", () => {
    const owner = {};
    const a = rows(1);
    const cols = ["id"];
    registerPageData("task", a, cols, owner);
    const v = pageDataVersion();
    registerPageData("task", a, cols, owner);
    expect(pageDataVersion()).toBe(v);
  });

  it("ignores a stale unregister from a block on the previous page", () => {
    const old = {};
    registerPageData("task", rows(1), ["id"], old);
    resetPageData();
    const fresh = {};
    const b = rows(2);
    registerPageData("task", b, ["id"], fresh);
    unregisterPageData("task", old);
    expect(getPageData("task")!.records).toBe(b);
  });
});
