/**
 * "Download this picture" for a widget.
 *
 * Two shapes to handle. A pure-SVG canvas (tree, graph, timeline, plane) can
 * be serialised directly, once the CSS custom properties it draws with are
 * resolved into literal colours — an `<svg>` taken out of the page loses the
 * cascade, and a diagram of `var(--kw-widget-border)` is a black-on-black
 * rectangle. A div-based canvas (array, matrix, table) has no such
 * serialisation, so it is drawn into an SVG `<foreignObject>` with the
 * computed styles inlined.
 *
 * `modern-screenshot` would do the second case more faithfully. It is ~40 KB
 * for a button most readers never press, so this stays dependency-free and
 * honest about being a snapshot rather than a render.
 */

const VAR_RE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g;
const SVG_NS = "http://www.w3.org/2000/svg";

export type SnapshotFailure = "no-canvas" | "rasterise" | "tainted";

export class SnapshotError extends Error {
  readonly reason: SnapshotFailure;
  constructor(reason: SnapshotFailure, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.reason = reason;
  }
}

/** Resolve `var(--x, fallback)` against the element's computed style. */
export function resolveVars(value: string, style: CSSStyleDeclaration): string {
  return value.replace(VAR_RE, (_match, name: string, fallback?: string) => {
    const resolved = style.getPropertyValue(name).trim();
    if (resolved) return resolveVars(resolved, style);
    return (fallback ?? "").trim();
  });
}

/** Safe inside a double-quoted XML attribute. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Presentation attributes and style properties that can hold a `var()`. */
const PAINT_ATTRS = ["fill", "stroke", "color", "stop-color", "flood-color"];

/**
 * What a div-based canvas needs written onto each element to keep its shape
 * once it is lifted out of the stylesheet: paint, box, and flex/grid layout.
 */
export const HTML_STYLES = [
  "display",
  "box-sizing",
  "position",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-self",
  "justify-content",
  "grid-template-columns",
  "grid-template-rows",
  "grid-column",
  "grid-row",
  "gap",
  "row-gap",
  "column-gap",
  "width",
  "height",
  "min-width",
  "min-height",
  "padding",
  "margin",
  "border",
  "border-radius",
  "background",
  "background-color",
  "color",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "white-space",
  "vertical-align",
  "fill",
  "stroke",
];

/** `prop:value;…` for the computed values of `props`, `var()`s resolved. */
export function inlineDeclarations(style: CSSStyleDeclaration, props: readonly string[]): string {
  return props
    .map((prop) => {
      const value = style.getPropertyValue(prop);
      return value ? `${prop}:${resolveVars(value, style)}` : "";
    })
    .filter(Boolean)
    .join(";");
}

/**
 * Replace every `var()` in a cloned subtree with the value it resolves to on
 * the live element at the same position.
 */
function inlinePaint(live: Element, clone: Element) {
  const style = getComputedStyle(live);
  for (const attr of PAINT_ATTRS) {
    const value = clone.getAttribute(attr);
    if (value && value.includes("var(")) clone.setAttribute(attr, resolveVars(value, style));
  }
  const inline = clone.getAttribute("style");
  if (inline && inline.includes("var(")) clone.setAttribute("style", resolveVars(inline, style));

  // A div-based canvas paints and lays out through the cascade, not through
  // attributes, so the computed values have to be written onto the clone.
  if (!(clone instanceof SVGElement)) {
    const declared = inlineDeclarations(style, HTML_STYLES);
    const existing = clone.getAttribute("style") ?? "";
    clone.setAttribute("style", existing ? `${declared};${existing}` : declared);
  }

  const liveKids = live.children;
  const cloneKids = clone.children;
  for (let i = 0; i < cloneKids.length && i < liveKids.length; i++) {
    inlinePaint(liveKids[i]!, cloneKids[i]!);
  }
}

/** The element to picture: the canvas, not the controls and captions around it. */
export function findCanvas(root: Element): Element {
  return root.querySelector("[data-kw-canvas]") ?? root;
}

/**
 * The canvas's own drawing, if it is one SVG: the largest top-level `<svg>`
 * that is not an icon inside a button and covers most of the canvas. A div
 * canvas that happens to contain an icon is not an SVG canvas.
 */
export function pickCanvasSvg(canvas: Element): SVGSVGElement | null {
  const area = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  let best: SVGSVGElement | null = null;
  let bestArea = 0;
  for (const svg of canvas.querySelectorAll<SVGSVGElement>("svg")) {
    if (svg.parentElement?.closest("svg")) continue;
    if (svg.closest("button, [role='toolbar']")) continue;
    const a = area(svg);
    if (a > bestArea) {
      best = svg;
      bestArea = a;
    }
  }
  const whole = area(canvas);
  if (!best || (whole > 0 && bestArea < whole * 0.5)) return null;
  return best;
}

export interface SnapshotOptions {
  /** Pixel scale for the PNG. Default 2, for a crisp retina image. */
  scale?: number;
  /** Background behind the picture. Defaults to the element's own. */
  background?: string;
}

function measure(el: Element): { w: number; h: number } {
  const { width, height } = el.getBoundingClientRect();
  return { w: Math.ceil(width), h: Math.ceil(height) };
}

/** Serialise a widget to standalone SVG markup, with its pixel size. */
function renderSVG(root: HTMLElement, opts: SnapshotOptions): { svg: string; w: number; h: number } {
  const canvas = findCanvas(root);
  const rootStyle = getComputedStyle(root);
  const background =
    opts.background ?? (resolveVars(rootStyle.backgroundColor || "transparent", rootStyle) || "transparent");

  const inner = pickCanvasSvg(canvas);
  if (inner) {
    const clone = inner.cloneNode(true) as SVGSVGElement;
    inlinePaint(inner, clone);
    const { w, h } = measure(inner);
    clone.setAttribute("xmlns", SVG_NS);
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    if (background !== "transparent") {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("width", "100%");
      rect.setAttribute("height", "100%");
      rect.setAttribute("fill", background);
      clone.insertBefore(rect, clone.firstChild);
    }
    return { svg: new XMLSerializer().serializeToString(clone), w, h };
  }

  const clone = canvas.cloneNode(true) as HTMLElement;
  inlinePaint(canvas, clone);
  const { w, h } = measure(canvas);
  if (w === 0 || h === 0) throw new SnapshotError("no-canvas", "the widget has no visible size");
  const font = getComputedStyle(canvas).fontFamily;
  return { svg: wrapForeignObject(new XMLSerializer().serializeToString(clone), w, h, background, font), w, h };
}

/** The `<foreignObject>` envelope for a serialised div canvas. */
export function wrapForeignObject(body: string, w: number, h: number, background: string, font: string): string {
  return [
    `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    background !== "transparent" ? `<rect width="100%" height="100%" fill="${escapeAttr(background)}"/>` : "",
    `<foreignObject width="${w}" height="${h}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="${escapeAttr(`font-family:${font}`)}">${body}</div>`,
    "</foreignObject>",
    "</svg>",
  ].join("");
}

/** Serialise a widget to standalone SVG markup. */
export function snapshotSVG(root: HTMLElement, opts: SnapshotOptions = {}): string {
  return renderSVG(root, opts).svg;
}

/** Rasterise the SVG snapshot. Rejects with a `SnapshotError`. */
export async function snapshotPNG(root: HTMLElement, opts: SnapshotOptions = {}): Promise<Blob> {
  const { svg, w, h } = renderSVG(root, opts);
  const scale = opts.scale ?? 2;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));

  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new SnapshotError("rasterise", "no 2d canvas context");
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new SnapshotError("rasterise", "the browser produced no image"))),
          "image/png",
        );
      } catch (err) {
        // Safari taints any canvas a foreignObject was drawn into.
        reject(toSnapshotError(err));
      }
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function toSnapshotError(err: unknown): SnapshotError {
  if (err instanceof SnapshotError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  return new SnapshotError(name === "SecurityError" ? "tainted" : "rasterise", message);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new SnapshotError("rasterise", "could not rasterise the snapshot"));
    img.src = url;
  });
}

/** Hand the file to the reader. */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // The click is synchronous, but Safari needs the URL alive a moment longer.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Download the widget as PNG or SVG. A PNG the browser refuses to rasterise
 * falls back to the SVG, which needs no canvas. Resolves to the format that
 * was actually saved; rejects with a `SnapshotError` when nothing could be.
 */
export async function downloadSnapshot(
  root: HTMLElement,
  name: string,
  format: "png" | "svg" = "png",
  opts: SnapshotOptions = {},
): Promise<"png" | "svg"> {
  const saveSVG = () => {
    download(new Blob([snapshotSVG(root, opts)], { type: "image/svg+xml" }), `${name}.svg`);
    return "svg" as const;
  };
  try {
    if (format === "svg") return saveSVG();
    let png: Blob;
    try {
      png = await snapshotPNG(root, opts);
    } catch (err) {
      const failure = toSnapshotError(err);
      if (failure.reason === "no-canvas") throw failure;
      return saveSVG();
    }
    download(png, `${name}.png`);
    return "png";
  } catch (err) {
    throw toSnapshotError(err);
  }
}
