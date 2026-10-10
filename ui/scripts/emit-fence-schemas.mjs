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

const { fenceCatalogueJSON } = await import(`file://${bundlePath}`);
const next = fenceCatalogueJSON();
await rm(bundlePath, { force: true });

const previous = await readFile(OUT, "utf8").catch(() => null);

if (process.argv.includes("--check")) {
  if (previous !== next) {
    process.stderr.write(
      `${OUT} is out of date.\nRun \`npm run emit-schemas\` in ui/ and commit the result.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${OUT} is up to date.\n`);
  process.exit(0);
}

if (previous === next) {
  process.stdout.write(`${OUT} unchanged.\n`);
} else {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, next);
  process.stdout.write(`wrote ${OUT}\n`);
}
