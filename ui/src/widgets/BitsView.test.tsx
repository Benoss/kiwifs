import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BitsView } from "./BitsView";

describe("BitsView", () => {
  it("shows a negative value as its two's complement bits", () => {
    const html = renderToStaticMarkup(<BitsView value={-5} bits={8} decode="twos" />);
    expect(html).toContain("0b11111011");
    expect(html).toContain(">-5<");
  });

  it("gives a negative value without bits a sign bit", () => {
    const html = renderToStaticMarkup(<BitsView value={-5} />);
    expect(html).toContain("0b1011");
  });

  it("decodes a 64-bit pattern passed as a hex string", () => {
    const html = renderToStaticMarkup(<BitsView value="0x3FB999999999999A" bits={64} decode="ieee64" />);
    expect(html).toContain(">0.1<");
  });

  it("renders a positive value as before", () => {
    const html = renderToStaticMarkup(<BitsView value={5} bits={4} />);
    expect(html).toContain("0b0101");
    expect(html).toContain("2 bits set");
  });
});
