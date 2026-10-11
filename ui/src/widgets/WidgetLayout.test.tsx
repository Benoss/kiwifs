import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WidgetLayout, WidgetPanel } from "./WidgetLayout";

describe("WidgetLayout tabs", () => {
  it("opens the panel named by tab", () => {
    const html = renderToStaticMarkup(
      <WidgetLayout direction="tabs" tab={1}>
        <WidgetPanel title="First">one</WidgetPanel>
        <WidgetPanel title="Second">two</WidgetPanel>
      </WidgetLayout>,
    );
    expect(html).toContain("two");
    expect(html).not.toContain(">one<");
    expect(html).toContain('role="tabpanel"');
  });

  it("clamps an out-of-range tab", () => {
    const html = renderToStaticMarkup(
      <WidgetLayout direction="tabs" tab={9}>
        <WidgetPanel title="A">alpha</WidgetPanel>
        <WidgetPanel title="B">beta</WidgetPanel>
      </WidgetLayout>,
    );
    expect(html).toContain("beta");
  });
});
