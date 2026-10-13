import { useEffect, useState } from "react";
import { api, ApiError } from "@kw/lib/api";
import { ShikiCode } from "./ShikiCode";

type Theme = "light" | "dark";

type State =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; message: string };

function currentTheme(): Theme {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * The server wraps errors as `{"error": "..."}` and replaces every 5xx message
 * with a generic one, so the 5xx cases are explained here by status.
 */
export function d2ErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 501) return "This kiwifs binary was built without D2 support.";
    if (error.status === 503) return "The D2 renderer timed out on this diagram.";
    if (error.status === 404) return "This server has no D2 renderer.";
    try {
      const parsed = JSON.parse(error.body) as { error?: unknown; message?: unknown };
      const text = parsed.error ?? parsed.message;
      if (typeof text === "string") return text;
    } catch {
      // not JSON
    }
    return error.body || error.message;
  }
  return "The D2 renderer could not be reached.";
}

/**
 * Only a 422 is a problem with the diagram. Anything else (no server in the
 * static demo, a build without D2, a timeout) shows the source, which is
 * still readable D2.
 */
export function isSourceError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 422;
}

export function D2Diagram({ source }: { source: string }) {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let url = "";
    setState({ kind: "loading" });
    api.renderD2(source, theme).then(
      (svg) => {
        if (cancelled) return;
        // An <img> never runs script or fetches what the SVG references,
        // which is what makes server output for untrusted source safe to show.
        url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setState({ kind: "ready", url });
      },
      (error) => {
        if (cancelled) return;
        const message = d2ErrorMessage(error);
        setState(isSourceError(error) ? { kind: "error", message } : { kind: "unavailable", message });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, theme]);

  if (state.kind === "unavailable") {
    return (
      <div className="kiwi-d2">
        <ShikiCode code={source} lang="d2" title="D2 diagram (not rendered)" />
        <p className="-mt-2 mb-4 text-xs text-muted-foreground">{state.message}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <figure className="kiwi-d2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
        <figcaption className="mb-2 text-sm font-medium text-destructive">D2 render error</figcaption>
        <pre className="overflow-x-auto text-xs">
          <code>{state.message}</code>
        </pre>
      </figure>
    );
  }

  return (
    <figure className="kiwi-d2 relative rounded-md border border-border bg-card p-2">
      {state.kind === "ready" ? (
        <>
          <div className="mb-1 flex justify-end text-xs">
            <a
              className="rounded-sm border border-border bg-card px-2 py-1 font-medium hover:bg-accent"
              href={state.url}
              download="diagram.svg"
              title="Download SVG"
            >
              SVG
            </a>
          </div>
          <div className="overflow-x-auto">
            <img src={state.url} alt="D2 diagram" className="mx-auto block max-w-full" style={{ height: "auto" }} />
          </div>
        </>
      ) : (
        <div className="h-24 animate-pulse rounded bg-muted" aria-label="Rendering D2 diagram" />
      )}
    </figure>
  );
}
