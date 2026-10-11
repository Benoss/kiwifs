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
   * Each `steps:` entry applies over the base rather than the previous step.
   * `kiwi-steps` bodies were written that way before the fence platform
   * existed, and reading them as deltas would carry a `dim:` into every
   * later step.
   */
  independentSteps?: boolean;
  /** `steps:` must be a non-empty list. */
  requireSteps?: boolean;
  /**
   * Renders two linked panels instead of one component (a heap as tree and
   * array, a union-find forest beside its parent array).
   */
  panels?: (body: Record<string, unknown>) => FencePanel[];
  /** A complete, pasteable fence body. Used by docs, slash menus and tests. */
  example: string;
  /** Prose fallback for PDF export, search indexing and `aria-label`. */
  summarize?: (props: P) => string;
  /**
   * Third-party widget registered through `registerWidget`. Rendered as
   * `<Component config={body} />` with the whole YAML mapping, as it always was.
   */
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
let generation = 0;

const STRICT_PREFIX = /^(kiwi-|widget:)/i;

/**
 * `kiwi-array` and `widget:array` always claim their block and report errors
 * loudly. Every other spelling — the bare name, a declared alias, a case
 * variant — has to be sniffed, because a vault may already use it for
 * something else. The Go linter applies the same rule.
 */
export function isStrictTag(lang: string): boolean {
  return STRICT_PREFIX.test(lang);
}

/** `kiwi-` and `widget:` spellings of a tag, unless it already has one. */
export function strictSpellings(lang: string): string[] {
  return isStrictTag(lang) ? [] : [`kiwi-${lang}`, `widget:${lang}`];
}

export function registerFence(spec: AnySpec): void {
  specs.set(spec.lang, spec);
  byAlias.set(spec.lang, spec.lang);
  for (const tag of strictSpellings(spec.lang)) byAlias.set(tag, spec.lang);
  for (const alias of spec.aliases ?? []) byAlias.set(alias, spec.lang);
}

export function unregisterFence(lang: string): boolean {
  const spec = specs.get(lang);
  if (!spec) return false;
  specs.delete(lang);
  for (const [alias, target] of [...byAlias]) if (target === lang) byAlias.delete(alias);
  return true;
}

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
  // Only an explicit spelling may name a third-party registration: a bare
  // ```chart in someone's vault must not turn into their embedder's widget.
  if (!isStrictTag(lang)) return undefined;
  const bare = lang.replace(STRICT_PREFIX, "");
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

/** Bumped by `clearFences`, so `registerBuiltinFences` knows to run again. */
export function registryGeneration(): number {
  return generation;
}

/** Test seam. */
export function clearFences(): void {
  specs.clear();
  byAlias.clear();
  generation++;
}
