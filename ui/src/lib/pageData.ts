/**
 * The `kiwi-data` blocks on the page being rendered.
 *
 * A dataset and the walkthrough that animates it should come from one source,
 * not two copies that drift. A `table` fence writes `fromData: <kind>` and
 * reads the records a `kiwi-data` block already declared — the same records
 * the server indexed for `FROM RECORDS "<kind>"`.
 *
 * Same tiny-store shape as `pageVars` and `playbackClock`: the data block and
 * the fence that reads it have no common React ancestor worth threading a
 * context through.
 */

import type { DataRecord } from "./dataBlock";

type Listener = () => void;

interface Entry {
  kind: string;
  records: DataRecord[];
  columns: string[];
}

const byKind = new Map<string, Entry>();
const listeners = new Set<Listener>();
let version = 0;

function refresh() {
  version += 1;
  for (const fn of listeners) fn();
}

export function subscribePageData(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Changes whenever a block registers or unregisters. */
export function pageDataVersion(): number {
  return version;
}

export function registerPageData(kind: string, records: DataRecord[], columns: string[]) {
  if (!kind) return;
  const existing = byKind.get(kind);
  if (existing && existing.records === records) return;
  byKind.set(kind, { kind, records, columns });
  refresh();
}

export function unregisterPageData(kind: string) {
  if (byKind.delete(kind)) refresh();
}

export function getPageData(kind: string): Entry | undefined {
  return byKind.get(kind);
}

export function pageDataKinds(): string[] {
  return [...byKind.keys()];
}

/** Test seam, and what a page navigation calls. */
export function resetPageData() {
  byKind.clear();
  refresh();
}
