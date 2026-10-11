/**
 * The fence platform's public surface. Importing anything from here
 * registers the built-ins.
 */

import { registerBuiltinFences } from "./builtins";
import { getFence as lookup, type FenceSpec } from "./registry";

registerBuiltinFences();

/** Resolve a language tag to its spec, registering the built-ins first. */
export function getFence(lang: string | undefined): FenceSpec | undefined {
  registerBuiltinFences();
  return lookup(lang);
}

export { registerBuiltinFences, BUILTIN_FENCES } from "./builtins";
export {
  allFences,
  clearFences,
  fenceLangs,
  isStrictTag,
  registerFence,
  type FenceSpec,
} from "./registry";
export { loadFenceYaml, parseFence, sniffFence, type ParsedFence } from "./parseFence";
export { parseFenceMeta, type FenceMeta } from "./meta";
export { TypedFence } from "./TypedFence";
export { serializeSchema, type Schema, type SchemaAttribute } from "./schema";
export { fenceCatalogue, fenceCatalogueJSON, type FenceCatalogue, type FenceDoc } from "./schemaJson";
