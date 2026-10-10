import { useEffect, useSyncExternalStore } from "react";
import {
  getPageVar,
  initPageVar,
  pageVars,
  setPageVar,
  subscribePageVars,
} from "@kw/lib/pageVars";

/**
 * A live control inside a sentence.
 *
 * `{% range name="n" min=1 max=64 /%}` is a number the reader can drag;
 * `{% value n /%}` prints it. A paragraph becomes something you can ask
 * questions of, and a fence further down can read `$n` — which is the point:
 * the prose and the picture agree because they share one variable.
 */

export interface KiwiControlProps {
  /** `range`, `value`, `toggle` or `select`. */
  kind: string;
  /** The tag's attributes, already JSON-decoded. */
  attrs: Record<string, string | number | boolean>;
}

function usePageVars() {
  return useSyncExternalStore(subscribePageVars, pageVars, pageVars);
}

export function KiwiControl({ kind, attrs }: KiwiControlProps) {
  const name = typeof attrs.name === "string" ? attrs.name : "";
  const vars = usePageVars();

  const declaredDefault =
    attrs.value !== undefined ? attrs.value : attrs.default !== undefined ? attrs.default : undefined;

  useEffect(() => {
    if (!name) return;
    if (declaredDefault !== undefined) {
      initPageVar(name, declaredDefault);
      return;
    }
    if (kind === "range" || kind === "select") {
      const min = Number(attrs.min ?? 0);
      initPageVar(name, kind === "range" ? min : String(firstOption(attrs) ?? ""));
    }
    if (kind === "toggle") initPageVar(name, false);
  }, [name, kind, declaredDefault, attrs]);

  if (!name) {
    return <code className="kiwi-control-error">{`{% ${kind} — missing name %}`}</code>;
  }

  const current = vars[name] ?? getPageVar(name);

  if (kind === "value") {
    const digits = Number(attrs.digits ?? NaN);
    const text =
      typeof current === "number" && Number.isFinite(digits)
        ? current.toFixed(digits)
        : current === undefined
          ? "…"
          : String(current);
    return (
      <span className="kiwi-control-value" data-var={name}>
        {attrs.prefix !== undefined ? String(attrs.prefix) : ""}
        {text}
        {attrs.suffix !== undefined ? String(attrs.suffix) : ""}
      </span>
    );
  }

  if (kind === "toggle") {
    const on = Boolean(current);
    return (
      <button
        type="button"
        className="kiwi-control-toggle"
        aria-pressed={on}
        onClick={() => setPageVar(name, !on)}
      >
        {on ? String(attrs.on ?? "on") : String(attrs.off ?? "off")}
      </button>
    );
  }

  if (kind === "select") {
    const options = optionList(attrs);
    return (
      <select
        className="kiwi-control-select"
        aria-label={name}
        value={String(current ?? options[0] ?? "")}
        onChange={(e) => setPageVar(name, e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  // range
  const min = Number(attrs.min ?? 0);
  const max = Number(attrs.max ?? 100);
  const step = Number(attrs.step ?? 1);
  const value = typeof current === "number" ? current : min;
  return (
    <span className="kiwi-control-range" data-var={name}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={name}
        onChange={(e) => setPageVar(name, Number(e.target.value))}
        style={{
          ["--kw-range-progress" as string]: `${max === min ? 0 : ((value - min) / (max - min)) * 100}%`,
        }}
      />
      <span className="kiwi-control-readout">
        {value}
        {attrs.suffix !== undefined ? String(attrs.suffix) : ""}
      </span>
    </span>
  );
}

function optionList(attrs: Record<string, string | number | boolean>): string[] {
  const raw = attrs.options;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstOption(attrs: Record<string, string | number | boolean>): string | undefined {
  return optionList(attrs)[0];
}
