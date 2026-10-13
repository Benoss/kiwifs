import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError } from "@kw/lib/api";
import { resolveFence } from "./FenceBlock";
import { D2Diagram, d2ErrorMessage, isSourceError } from "./D2Diagram";

describe("d2 fence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("routes ```d2, including a one-line diagram", () => {
    expect(resolveFence("d2", "a -> b").kind).toBe("d2");
    expect(resolveFence("d2", "a -> b\nb -> c").kind).toBe("d2");
  });

  it("shows a placeholder until the server answers", () => {
    expect(renderToStaticMarkup(<D2Diagram source="a -> b" />)).toContain("Rendering D2 diagram");
  });

  it("reads D2's message out of the server's JSON error", () => {
    const err = new ApiError(422, "Unprocessable Entity", '{"error":"1:1: connection missing destination"}', "/x");
    expect(d2ErrorMessage(err)).toBe("1:1: connection missing destination");
    expect(isSourceError(err)).toBe(true);
    expect(d2ErrorMessage(new ApiError(400, "Bad Request", "plain text", "/x"))).toBe("plain text");
  });

  it("explains 5xx by status, since the server hides 5xx messages", () => {
    const hidden = '{"error":"internal server error"}';
    expect(d2ErrorMessage(new ApiError(501, "Not Implemented", hidden, "/x"))).toMatch(/built without D2/);
    expect(d2ErrorMessage(new ApiError(503, "Service Unavailable", hidden, "/x"))).toMatch(/timed out/);
    expect(d2ErrorMessage(new TypeError("Failed to fetch"))).toMatch(/could not be reached/);
  });

  it("treats anything but a 422 as unrenderable, not as a broken diagram", () => {
    expect(isSourceError(new ApiError(501, "Not Implemented", "", "/x"))).toBe(false);
    expect(isSourceError(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("GETs short sources so read-only viewers can render, and POSTs long ones", async () => {
    const fetchMock = vi.fn(async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.renderD2("a -> b", "dark")).resolves.toBe("<svg/>");
    const [shortUrl, shortInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(shortUrl).toContain("/render/d2?");
    expect(shortUrl).toContain("theme=dark");
    expect(shortInit.method).toBeUndefined();

    const long = Array.from({ length: 800 }, (_, i) => `node${i} -> node${i + 1}`).join("\n");
    await api.renderD2(long, "light");
    const [longUrl, longInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(longUrl).toMatch(/\/render\/d2$/);
    expect(longInit.method).toBe("POST");
    expect(JSON.parse(String(longInit.body))).toEqual({ source: long, theme: "light" });
  });
});
