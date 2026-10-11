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

interface Registration extends Entry {
  owner: object;
}

/**
 * Every block registered under a kind, in registration order; the latest one
 * is what readers see. Two blocks of one kind each own their registration, so
 * one unmounting cannot take the other's records with it.
 */
const byKind = new Map<string, Registration[]>();
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

/**
 * Publish `records` under `kind`. `owner` identifies the block; without one
 * the records array stands in for it.
 */
export function registerPageData(kind: string, records: DataRecord[], columns: string[], owner: object = records) {
  if (!kind) return;
  const list = byKind.get(kind) ?? [];
  const at = list.findIndex((r) => r.owner === owner);
  if (at >= 0 && list[at]!.records === records && list[at]!.columns === columns) return;
  const entry: Registration = { kind, records, columns, owner };
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  byKind.set(kind, list);
  refresh();
}

/** Withdraw `owner`'s records, or every block's under `kind` if no owner is given. */
export function unregisterPageData(kind: string, owner?: object) {
  const list = byKind.get(kind);
  if (!list) return;
  if (owner === undefined) {
    byKind.delete(kind);
    refresh();
    return;
  }
  const at = list.findIndex((r) => r.owner === owner);
  if (at < 0) return;
  list.splice(at, 1);
  if (list.length === 0) byKind.delete(kind);
  refresh();
}

export function getPageData(kind: string): Entry | undefined {
  const list = byKind.get(kind);
  return list?.[list.length - 1];
}

export function pageDataKinds(): string[] {
  return [...byKind.keys()];
}

/** Test seam, and what a page navigation calls. */
export function resetPageData() {
  byKind.clear();
  refresh();
}
