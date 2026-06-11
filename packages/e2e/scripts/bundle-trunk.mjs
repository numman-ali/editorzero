/**
 * Bundle the server trunk (`apps/server/src/index.ts`) into one runnable
 * ESM file for the e2e webServer — `node tmp/server.mjs`.
 *
 * Why a bundle at all: the repo compiles with `module: Preserve`, so every
 * package's `dist/` keeps extensionless relative imports — fine for
 * bundler-resolved consumers (Vite, bun, vitest), unrunnable under plain
 * `node`. Bun can't host the trunk either (`better-sqlite3` is a native
 * module bun doesn't support — oven-sh/bun#4290). esbuild resolves the
 * whole workspace graph from source and emits one file node can run; the
 * same approach is the candidate shape for the production server artifact
 * (docker slice).
 *
 * `better-sqlite3` stays external (native .node binding can't be bundled);
 * it resolves at runtime from this package's own node_modules, which is why
 * it appears in our devDependencies. The banner restores `require` for CJS
 * deps (pg) that esbuild wraps inside the ESM output.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

await build({
  entryPoints: [path.join(repoRoot, "apps/server/src/index.ts")],
  outfile: path.join(here, "../tmp/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3"],
  banner: {
    js: "import { createRequire as __ezCreateRequire } from 'node:module'; const require = __ezCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});
