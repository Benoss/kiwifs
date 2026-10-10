/**
 * Writes the fence catalogue that Go embeds.
 *
 *   node scripts/emit-fence-schemas.mjs           # write
 *   node scripts/emit-fence-schemas.mjs --check   # fail if it would change
 *
 * `make ui` runs the write; CI runs the check, so a spec edited without
 * regenerating is caught before the Go linter starts disagreeing with the UI.
 *
 * The specs are bundled with esbuild rather than imported directly, because
 * they are TypeScript. View components stay external: a spec only mentions
 * them inside `lazy(() => import(…))`, which never runs here, and bundling
 * them would drag katex and mermaid into a build script.
 */

import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "..");
const repoRoot = resolve(uiRoot, "..");
const OUT = resolve(repoRoot, "internal/markdown/fenceschemas/fences.json");
const DOCS = resolve(repoRoot, "docs/WIDGETS.md");

/** `@kw/widgets/ArrayView` is a component; `@kw/widgets/sets` is a helper. */
const componentPath = /^@kw\/(widgets|components)\/[A-Z]/;

const externalComponents = {
  name: "external-components",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: componentPath }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const bundlePath = resolve(uiRoot, "node_modules/.cache/fence-schemas.mjs");

await mkdir(dirname(bundlePath), { recursive: true });
await build({
  entryPoints: [resolve(uiRoot, "src/fences/schemaJson.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
  external: ["react", "react-dom", "js-yaml"],
  alias: { "@kw": resolve(uiRoot, "src") },
  plugins: [externalComponents],
});

const { fenceCatalogueJSON, referenceMarkdown } = await import(`file://${bundlePath}`);
const outputs = [
  { path: OUT, content: fenceCatalogueJSON() },
  { path: DOCS, content: `${referenceMarkdown().replace(/\n*$/, "")}\n` },
];
await rm(bundlePath, { force: true });

const checking = process.argv.includes("--check");
let stale = false;

for (const { path, content } of outputs) {
  const previous = await readFile(path, "utf8").catch(() => null);
  if (previous === content) {
    if (!checking) process.stdout.write(`${path} unchanged.\n`);
    continue;
  }
  if (checking) {
    process.stderr.write(`${path} is out of date.\n`);
    stale = true;
    continue;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  process.stdout.write(`wrote ${path}\n`);
}

if (checking) {
  if (stale) {
    process.stderr.write("Run `npm run emit-schemas` in ui/ and commit the result.\n");
    process.exit(1);
  }
  process.stdout.write("Generated fence files are up to date.\n");
}
