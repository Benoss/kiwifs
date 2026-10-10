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

/** Resolve `var(--x, fallback)` against the element's computed style. */
export function resolveVars(value: string, style: CSSStyleDeclaration): string {
  return value.replace(VAR_RE, (_match, name: string, fallback?: string) => {
    const resolved = style.getPropertyValue(name).trim();
    if (resolved) return resolveVars(resolved, style);
    return (fallback ?? "").trim();
  });
}

/** Presentation attributes and style properties that can hold a `var()`. */
const PAINT_ATTRS = ["fill", "stroke", "color", "stop-color", "flood-color"];
const PAINT_STYLES = ["fill", "stroke", "color", "background", "background-color", "border-color"];

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

  // A div-based canvas paints through the cascade, not through attributes, so
  // the computed values have to be written onto the clone.
  if (!(clone instanceof SVGElement)) {
    const declared = PAINT_STYLES.map((prop) => {
      const value = style.getPropertyValue(prop);
      return value ? `${prop}:${value}` : "";
    })
      .filter(Boolean)
      .join(";");
    const existing = clone.getAttribute("style") ?? "";
    clone.setAttribute("style", `${declared};${existing}`);
  }

  const liveKids = live.children;
  const cloneKids = clone.children;
  for (let i = 0; i < cloneKids.length && i < liveKids.length; i++) {
    inlinePaint(liveKids[i]!, cloneKids[i]!);
  }
}

export interface SnapshotOptions {
  /** Pixel scale for the PNG. Default 2, for a crisp retina image. */
  scale?: number;
  /** Background behind the picture. Defaults to the element's own. */
  background?: string;
}

/** Serialise a widget to standalone SVG markup. */
export function snapshotSVG(root: HTMLElement, opts: SnapshotOptions = {}): string {
  const style = getComputedStyle(root);
  const background =
    opts.background ?? (resolveVars(style.backgroundColor || "transparent", style) || "transparent");

  const inner = root.querySelector("svg");
  if (inner) {
    const clone = inner.cloneNode(true) as SVGSVGElement;
    inlinePaint(inner, clone);
    const { width, height } = inner.getBoundingClientRect();
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!clone.getAttribute("viewBox")) {
      clone.setAttribute("viewBox", `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
    }
    clone.setAttribute("width", String(Math.ceil(width)));
    clone.setAttribute("height", String(Math.ceil(height)));
    if (background !== "transparent") {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("width", "100%");
      rect.setAttribute("height", "100%");
      rect.setAttribute("fill", background);
      clone.insertBefore(rect, clone.firstChild);
    }
    return new XMLSerializer().serializeToString(clone);
  }

  // Div-based: wrap the markup in a foreignObject.
  const clone = root.cloneNode(true) as HTMLElement;
  inlinePaint(root, clone);
  const { width, height } = root.getBoundingClientRect();
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const body = new XMLSerializer().serializeToString(clone);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    background !== "transparent" ? `<rect width="100%" height="100%" fill="${background}"/>` : "",
    `<foreignObject width="${w}" height="${h}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:${style.fontFamily}">${body}</div>`,
    "</foreignObject>",
    "</svg>",
  ].join("");
}

/** Rasterise the SVG snapshot. Rejects if the browser refuses to draw it. */
export async function snapshotPNG(root: HTMLElement, opts: SnapshotOptions = {}): Promise<Blob> {
  const svg = snapshotSVG(root, opts);
  const scale = opts.scale ?? 2;
  const { width, height } = root.getBoundingClientRect();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));

  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not rasterise the snapshot"));
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

export async function downloadSnapshot(
  root: HTMLElement,
  name: string,
  format: "png" | "svg" = "png",
  opts: SnapshotOptions = {},
): Promise<void> {
  if (format === "svg") {
    download(new Blob([snapshotSVG(root, opts)], { type: "image/svg+xml" }), `${name}.svg`);
    return;
  }
  download(await snapshotPNG(root, opts), `${name}.png`);
}
