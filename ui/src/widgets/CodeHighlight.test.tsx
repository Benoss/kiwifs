import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeHighlight } from "./CodeHighlight";

describe("CodeHighlight arrow gutter", () => {
  it("is absent without nextLine, so existing blocks keep their layout", () => {
    const html = renderToStaticMarkup(<CodeHighlight code={"a = 1\nb = 2"} activeLine={0} lang="none" />);
    expect(html).not.toContain("width:12px");
    expect(html).not.toContain("▸");
  });

  it("appears on every line once nextLine is set", () => {
    const html = renderToStaticMarkup(<CodeHighlight code={"a = 1\nb = 2"} activeLine={0} nextLine={1} lang="none" />);
    expect([...html.matchAll(/width:12px/g)]).toHaveLength(2);
    expect([...html.matchAll(/▸/g)]).toHaveLength(2);
  });
});
