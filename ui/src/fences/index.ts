/**
 * Registers the built-in fences. Imported for its side effect by whatever
 * renders markdown, and by the schema emitter that writes `fences.json`.
 */

import { registerFence } from "./registry";
import { arraySpec } from "./specs/array";
import { matrixSpec } from "./specs/matrix";
import { graphSpec } from "./specs/graph";
import { treeSpec } from "./specs/tree";
import { plotSpec } from "./specs/plot";
import { stepsSpec } from "./specs/steps";
import { tableSpec } from "./specs/table";
import { numberlineSpec } from "./specs/numberline";
import { mapSpec } from "./specs/map";
import { planeSpec } from "./specs/plane";
import { timelineSpec } from "./specs/timeline";
import { listSpec } from "./specs/list";
import { stackSpec } from "./specs/stack";
import { bitsSpec } from "./specs/bits";
import { barsSpec } from "./specs/bars";
import { sequenceSpec } from "./specs/sequence";

let registered = false;

export function registerBuiltinFences(): void {
  if (registered) return;
  registered = true;
  for (const spec of [
    arraySpec,
    matrixSpec,
    tableSpec,
    treeSpec,
    graphSpec,
    plotSpec,
    barsSpec,
    numberlineSpec,
    planeSpec,
    mapSpec,
    timelineSpec,
    listSpec,
    stackSpec,
    bitsSpec,
    sequenceSpec,
    stepsSpec,
  ]) {
    registerFence(spec);
  }
}

registerBuiltinFences();

export { getFence, allFences, fenceLangs, registerFence, type FenceSpec } from "./registry";
export { parseFence, sniffFence, type ParsedFence } from "./parseFence";
export { parseFenceMeta, type FenceMeta } from "./meta";
export { TypedFence } from "./TypedFence";
export { serializeSchema, type Schema, type SchemaAttribute } from "./schema";
