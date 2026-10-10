/**
 * The fence registry: one `FenceSpec` per picture a page can draw.
 *
 * `widget:array`, `kiwi-array` and ` ```array ` all resolve here, so there is
 * one description, one schema and one example per widget however an author
 * spells it. `widgets/registry.ts` keeps its own map of third-party widgets
 * and is consulted last, which is what keeps `registerWidget` working.
 */

import type { ComponentType } from "react";
import type { ParsedFence } from "./parseFence";
import type { Schema } from "./schema";
import { getWidget, type WidgetComponent } from "@kw/widgets/registry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface FenceSpec<P = any> {
  /** Canonical language tag, e.g. "array". */
  lang: string;
  /** Extra tags that resolve here. `kiwi-<lang>` and `widget:<lang>` are automatic. */
  aliases?: string[];
  /** One line, shown in the slash menu, docs, and `kiwi_widget_reference`. */
  description: string;
  // Props are built from YAML at render time, so the registry cannot prove the
  // shape statically; `normalize` and the schema are what keep it honest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  schema: Schema;
  /**
   * Keys that mark a body as really belonging to this fence. A bare ` ```tree `
   * holding a directory listing has none of them and falls through to Shiki.
   * Any one of them is enough.
   */
  required?: string[];
  /** Replaces the `required` test when a spec needs a sharper one. */
  sniff?: (body: Record<string, unknown>) => boolean;
  /**
   * Keys of which at least one has to be present. A `table` needs its rows
   * from somewhere — `rows:`, or `fromData:` naming a dataset on the page —
   * and no single key can be marked required to say that.
   */
  requireOneOf?: string[];
  /** Shape the validated body into the component's props. */
  normalize?: (body: Record<string, unknown>) => P;
  /**
   * Fill in step props the author did not have to write — a sequence diagram
   * revealing one more message per step, a frame count derived from the data.
   * Runs once after parsing, before any step is rendered.
   */
  prepare?: (parsed: ParsedFence) => ParsedFence;
  /** Receive `onNavigate`, for a canvas whose labels can be wiki links. */
  needsNavigate?: boolean;
  /**
   * Reserved names this fence uses as ordinary props. `sequence` draws
   * grouping boxes it has always called `frames`, which would otherwise be
   * read as the "one full prop set per step" form.
   */
  reclaims?: string[];
  /**
   * Renders two linked panels instead of one component (a heap as tree and
   * array, a union-find forest beside its parent array).
   */
  panels?: (body: Record<string, unknown>) => FencePanel[];
  /** A complete, pasteable fence body. Used by docs, slash menus and tests. */
  example: string;
  /** Prose fallback for PDF export, search indexing and `aria-label`. */
  summarize?: (props: P) => string;
  /** Third-party widget registered through `registerWidget`. */
  legacy?: boolean;
}

export interface FencePanel {
  key: string;
  label?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  props: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpec = FenceSpec<any>;

const specs = new Map<string, AnySpec>();
const byAlias = new Map<string, string>();

export function registerFence(spec: AnySpec): void {
  specs.set(spec.lang, spec);
  byAlias.set(spec.lang, spec.lang);
  byAlias.set(`kiwi-${spec.lang}`, spec.lang);
  byAlias.set(`widget:${spec.lang}`, spec.lang);
  for (const alias of spec.aliases ?? []) byAlias.set(alias, spec.lang);
}

export function unregisterFence(lang: string): boolean {
  const spec = specs.get(lang);
  if (!spec) return false;
  specs.delete(lang);
  for (const [alias, target] of [...byAlias]) if (target === lang) byAlias.delete(alias);
  return true;
}

/** Legacy widgets take the whole YAML mapping as one `config` prop. */
function legacySpec(name: string, component: WidgetComponent): AnySpec {
  return {
    lang: name,
    description: `Third-party widget "${name}".`,
    component,
    schema: { attributes: {} },
    example: `\`\`\`widget:${name}\n\`\`\``,
    legacy: true,
  };
}

export function getFence(lang: string | undefined): AnySpec | undefined {
  if (!lang) return undefined;
  const target = byAlias.get(lang) ?? byAlias.get(lang.toLowerCase());
  if (target) return specs.get(target);
  // `widget:foo` / `kiwi-foo` may still name a third-party registration.
  const bare = lang.replace(/^widget:/, "").replace(/^kiwi-/, "");
  const legacy = getWidget(bare);
  return legacy ? legacySpec(bare, legacy) : undefined;
}

/** Every built-in spec, in registration order. */
export function allFences(): AnySpec[] {
  return [...specs.values()];
}

export function fenceLangs(): string[] {
  return [...specs.keys()];
}

/** Test seam. */
export function clearFences(): void {
  specs.clear();
  byAlias.clear();
}
