/**
 * The fence catalogue as plain JSON.
 *
 * One file, three readers: the Go linter embeds it to check a fence on write,
 * `kiwi_widget_reference` serves it to agents, and `docs/WIDGETS.md` is
 * generated from it. A description written in a spec therefore appears
 * everywhere, and cannot drift between surfaces.
 */

import { registerBuiltinFences } from "./builtins";
import { allFences } from "./registry";
import { RESERVED_STEP, RESERVED_TOP_LEVEL, serializeSchema, type SerializedAttribute } from "./schema";

export interface FenceDoc {
  lang: string;
  aliases: string[];
  description: string;
  /** Any one of these keys marks a bare fence as belonging to this widget. */
  required: string[];
  example: string;
  attributes: Record<string, SerializedAttribute>;
}

export interface FenceCatalogue {
  /** Bumped when the shape of this file changes, not when a fence is added. */
  version: number;
  /** Keys every fence understands, stripped before the widget sees them. */
  reservedTopLevel: string[];
  /** Keys a step may carry that are not widget props. */
  reservedStep: string[];
  fences: FenceDoc[];
}

export function fenceCatalogue(): FenceCatalogue {
  registerBuiltinFences();
  const fences = allFences()
    .filter((spec) => !spec.legacy)
    .map<FenceDoc>((spec) => ({
      lang: spec.lang,
      aliases: [`kiwi-${spec.lang}`, `widget:${spec.lang}`, ...(spec.aliases ?? [])],
      description: spec.description,
      required:
        spec.required ??
        Object.entries(spec.schema.attributes)
          .filter(([, a]) => a.required)
          .map(([k]) => k),
      example: spec.example,
      attributes: serializeSchema(spec.schema),
    }))
    .sort((a, b) => a.lang.localeCompare(b.lang));

  return {
    version: 1,
    reservedTopLevel: [...RESERVED_TOP_LEVEL],
    reservedStep: [...RESERVED_STEP],
    fences,
  };
}

export function fenceCatalogueJSON(): string {
  return `${JSON.stringify(fenceCatalogue(), null, 2)}\n`;
}
