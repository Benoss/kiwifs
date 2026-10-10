import { useEffect, useRef } from "react";
import { alpha } from "./colors";
import { hasMath } from "./widgetLabel";
import { WidgetText } from "./WidgetText";
import { useLocalState } from "./useLocalState";

export type InputFieldType =
  | "number"
  | "text"
  | "array"
  | "boolean"
  | "slider"
  | "select"
  | "radio";

export interface InputOption {
  value: string | number;
  label?: string;
}

export interface InputField {
  key: string;
  label: string;
  type: InputFieldType;
  defaultValue: unknown;
  /** For numbers and sliders: lower bound. */
  min?: number;
  /** For numbers and sliders: upper bound. */
  max?: number;
  /** For numbers and sliders: granularity. Default 1. */
  step?: number;
  /** For select and radio: the choices. Strings are shorthand for `{value}`. */
  options?: (InputOption | string | number)[];
  /** For arrays: separator (default ","). */
  separator?: string;
  /**
   * Arrays of strings rather than numbers — words to match, labels to sort.
   * The parser used to coerce everything to Number and silently drop text.
   */
  values?: "number" | "string";
  /** Unit shown after the control: `ms`, `%`, `req/s`. */
  unit?: string;
}

export interface InputPanelProps {
  fields: InputField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  /** Optional title. */
  title?: string;
  /** Layout: "row" or "column". Default "row". */
  layout?: "row" | "column";
  /**
   * Remember what the reader set, in their own `.me/<persist>.json`.
   *
   * Reader state, not page state: a page's defaults stay in the file, and a
   * reader's exploration follows them across visits without being committed.
   */
  persist?: string;
}

const DEFAULTS = {
  dimColor: "var(--kw-widget-dim, #94a3b8)",
  border: "var(--kw-widget-border, #3f3f46)",
  text: "var(--kw-widget-text, #e5e7eb)",
  active: "var(--kw-widget-active, #a78bfa)",
};

function parseArray(s: string, sep: string, kind: "number" | "string"): (number | string)[] {
  const parts = s.split(sep).map((v) => v.trim()).filter(Boolean);
  if (kind === "string") return parts;
  return parts.map(Number).filter((n) => !isNaN(n));
}

function normalizeOptions(options: InputField["options"]): InputOption[] {
  return (options ?? []).map((o) =>
    typeof o === "object" ? o : { value: o, label: String(o) },
  );
}

const inputStyle = (width: number) => ({
  width,
  padding: "3px 6px",
  borderRadius: 4,
  border: `1px solid ${DEFAULTS.border}`,
  background: "transparent",
  color: DEFAULTS.text,
  fontSize: "0.8rem",
});

export function InputPanel({
  fields,
  values,
  onChange,
  title,
  layout = "row",
  persist,
}: InputPanelProps) {
  usePersistedInputs(persist, fields, values, onChange);

  return (
    <div style={{
      borderRadius: 8,
      border: `1px solid ${DEFAULTS.border}`,
      padding: "8px 12px",
      fontSize: "0.8rem",
    }}>
      {title && (
        <div style={{
          fontSize: "0.7rem",
          fontWeight: 600,
          color: DEFAULTS.dimColor,
          textTransform: hasMath(title) ? "none" : "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 6,
        }}>
          <WidgetText text={title} />
        </div>
      )}
      <div style={{
        display: "flex",
        flexDirection: layout === "row" ? "row" : "column",
        gap: layout === "row" ? 16 : 8,
        flexWrap: "wrap",
        alignItems: layout === "row" ? "center" : undefined,
      }}>
        {fields.map((field) => {
          const val = values[field.key] ?? field.defaultValue;
          const options = normalizeOptions(field.options);

          return (
            <div key={field.key} style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}>
              <label style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                color: DEFAULTS.dimColor,
                whiteSpace: "nowrap",
              }}>
                <WidgetText text={field.label} />
              </label>

              {field.type === "number" && (
                <input
                  type="number"
                  value={val as number}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  onChange={(e) => onChange(field.key, Number(e.target.value))}
                  style={{
                    ...inputStyle(64),
                    fontFamily: "ui-monospace, monospace",
                    fontVariantNumeric: "tabular-nums",
                  }}
                />
              )}

              {field.type === "slider" && (
                <>
                  <input
                    type="range"
                    value={Number(val)}
                    min={field.min ?? 0}
                    max={field.max ?? 100}
                    step={field.step ?? 1}
                    onChange={(e) => onChange(field.key, Number(e.target.value))}
                    style={{
                      width: 120,
                      ["--kw-range-progress" as string]: `${sliderProgress(Number(val), field)}%`,
                    }}
                  />
                  {/* The number beside the slider: a scrubber with no readout
                      tells the reader a shape but never a value. */}
                  <span style={{
                    minWidth: 32,
                    fontFamily: "ui-monospace, monospace",
                    fontVariantNumeric: "tabular-nums",
                    color: DEFAULTS.text,
                  }}>
                    {String(val)}
                  </span>
                </>
              )}

              {field.type === "select" && (
                <select
                  value={String(val)}
                  onChange={(e) => onChange(field.key, coerceOption(e.target.value, options))}
                  style={inputStyle(120)}
                >
                  {options.map((o) => (
                    <option key={String(o.value)} value={String(o.value)}>
                      {o.label ?? String(o.value)}
                    </option>
                  ))}
                </select>
              )}

              {field.type === "radio" && (
                <div style={{ display: "flex", gap: 4 }}>
                  {options.map((o) => {
                    const on = String(val) === String(o.value);
                    return (
                      <button
                        key={String(o.value)}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onChange(field.key, o.value)}
                        style={{
                          padding: "2px 9px",
                          borderRadius: 999,
                          border: `1px solid ${on ? DEFAULTS.active : DEFAULTS.border}`,
                          background: on ? alpha(DEFAULTS.active, 18) : "transparent",
                          color: on ? DEFAULTS.text : DEFAULTS.dimColor,
                          fontSize: "0.72rem",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {o.label ?? String(o.value)}
                      </button>
                    );
                  })}
                </div>
              )}

              {field.type === "text" && (
                <input
                  type="text"
                  value={val as string}
                  onChange={(e) => onChange(field.key, e.target.value)}
                  style={inputStyle(120)}
                />
              )}

              {field.type === "array" && (
                <input
                  type="text"
                  value={Array.isArray(val) ? (val as unknown[]).join(field.separator ?? ", ") : String(val)}
                  onChange={(e) =>
                    onChange(
                      field.key,
                      parseArray(e.target.value, field.separator ?? ",", field.values ?? "number"),
                    )
                  }
                  style={{ ...inputStyle(180), fontFamily: "ui-monospace, monospace" }}
                />
              )}

              {field.type === "boolean" && (
                <button
                  type="button"
                  aria-pressed={Boolean(val)}
                  onClick={() => onChange(field.key, !val)}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    border: `1px solid ${DEFAULTS.border}`,
                    background: val ? alpha("var(--kw-widget-highlight, #22c55e)", 18) : "transparent",
                    color: val ? "var(--kw-widget-highlight, #22c55e)" : DEFAULTS.dimColor,
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {val ? "true" : "false"}
                </button>
              )}

              {field.unit && (
                <span style={{ fontSize: "0.7rem", color: DEFAULTS.dimColor }}>{field.unit}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sliderProgress(value: number, field: InputField): number {
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  if (max === min) return 0;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

/** Keep a select's value typed as the option declared it. */
function coerceOption(raw: string, options: InputOption[]): string | number {
  const match = options.find((o) => String(o.value) === raw);
  return match ? match.value : raw;
}

/**
 * Restore saved values once, then write back on every change.
 *
 * Restoring once rather than continuously matters: a reader who moves a slider
 * must not have it snapped back by the save that their own move triggered.
 */
function usePersistedInputs(
  persist: string | undefined,
  fields: InputField[],
  values: Record<string, unknown>,
  onChange: (key: string, value: unknown) => void,
) {
  const state = useLocalState<Record<string, unknown>>(persist ?? "");
  const restored = useRef(false);
  const known = fields.map((f) => f.key).join(",");

  useEffect(() => {
    if (!persist || restored.current || state.loading || !state.data) return;
    restored.current = true;
    for (const field of fields) {
      const saved = state.data[field.key];
      if (saved !== undefined) onChange(field.key, saved);
    }
    // `known` is in the deps so a fence that adds a field restores it too.
  }, [persist, state.loading, state.data, fields, onChange, known]);

  useEffect(() => {
    if (!persist || !restored.current) return;
    const timer = setTimeout(() => {
      void state.save({ ...(state.data ?? {}), ...values });
    }, 400);
    return () => clearTimeout(timer);
    // `state.save` is stable; `state.data` would retrigger on every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, values]);
}
