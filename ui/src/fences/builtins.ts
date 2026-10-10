/**
 * Registers the built-in fences.
 *
 * Separate from `index.ts` so the schema emitter can pull in the specs without
 * pulling in `TypedFence` and, through it, every view component.
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
import { queueSpec } from "./specs/queue";
import { memorySpec } from "./specs/memory";

/** Docs order: the ones an author reaches for first come first. */
export const BUILTIN_FENCES = [
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
  queueSpec,
  bitsSpec,
  sequenceSpec,
  memorySpec,
  stepsSpec,
];

let registered = false;

/**
 * Idempotent, and called explicitly rather than relied on as a module side
 * effect: `"sideEffects": ["*.css"]` in package.json means a bare
 * `import "./builtins"` is legally dropped by a bundler, which once produced
 * an empty fence catalogue.
 */
export function registerBuiltinFences(): void {
  if (registered) return;
  registered = true;
  for (const spec of BUILTIN_FENCES) registerFence(spec);
}
