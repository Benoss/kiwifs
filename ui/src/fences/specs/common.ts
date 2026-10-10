/**
 * Attribute shorthands shared by every spec.
 *
 * The schema is read by three consumers — the UI validator, the Go linter via
 * `fences.json`, and `kiwi_widget_reference` over MCP — so a description
 * written here is the only description of that key anywhere.
 */

import type { SchemaAttribute } from "../schema";

export function string(description: string, steppable = true): SchemaAttribute {
  return { type: "string", description, ...(steppable ? {} : { steppable: false }) };
}

export function number(description: string, steppable = true): SchemaAttribute {
  return { type: "number", description, ...(steppable ? {} : { steppable: false }) };
}

export function bool(description: string, steppable = true): SchemaAttribute {
  return { type: "boolean", description, ...(steppable ? {} : { steppable: false }) };
}

/** A highlight set: a Set, a list, or a bare value. */
export function many(description: string): SchemaAttribute {
  return { type: ["array", "number", "string"], description };
}

/** Cell references: `[r, c]` pairs or `"r,c"` strings, or one of either. */
export function cells(description: string): SchemaAttribute {
  return { type: ["array", "string", "object"], description };
}

export function objectList(description: string): SchemaAttribute {
  return { type: "array", items: "object", description };
}

export function stringList(description: string): SchemaAttribute {
  return { type: "array", items: "string", description };
}

export function numberList(description: string): SchemaAttribute {
  return { type: "array", items: "number", description };
}

export function anyValue(description: string): SchemaAttribute {
  return { type: "any", description };
}

export function enumOf(
  values: readonly string[],
  description: string,
  steppable = true,
): SchemaAttribute {
  return {
    type: "string",
    matches: values,
    description,
    ...(steppable ? {} : { steppable: false }),
  };
}

/** Keys every canvas accepts: colors, sizing, and the accessible name. */
export const CANVAS_ATTRS: Record<string, SchemaAttribute> = {
  activeColor: string("Primary highlight color.", false),
  highlightColor: string("Secondary highlight color.", false),
  ariaLabel: string("Accessible name. Defaults to a summary derived from the data.", false),
  props: anyValue("Escape hatch for a widget prop whose name collides with a reserved key."),
};
