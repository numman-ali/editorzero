/**
 * Bundle the server trunk (`src/index.ts`) into one runnable ESM file —
 * THE production server artifact (ADR 0012/0027) and the e2e harness's
 * trunk (`packages/e2e` calls this with `--out tmp/server.mjs`).
 *
 * Why a bundle at all: the repo compiles with `module: Preserve`, so every
 * package's `dist/` keeps extensionless relative imports — fine for
 * bundler-resolved consumers (Vite, bun, vitest), unrunnable under plain
 * `node`. Bun can't host the trunk either (`better-sqlite3` is a native
 * module bun doesn't support — oven-sh/bun#4290). esbuild emits one file
 * node can run.
 *
 * `tsc -b` first, every run: only the *entry* bundles from source —
 * `@editorzero/*` imports resolve through package exports to each
 * package's `dist/`. Without the rebuild the bundle silently embeds
 * stale dists and consumers green-light code that was never built.
 * Incremental, so near-free when dists are current.
 *
 * `better-sqlite3` stays external (native .node binding can't be bundled);
 * it must resolve at runtime from a `node_modules` near the emitted file —
 * this package's own devDependency for local runs / packages/e2e's for the
 * e2e lane / the `pnpm deploy`ed tree in the docker image. The banner
 * restores `require` for CJS deps (pg) that esbuild wraps inside the ESM
 * output.
 *
 * Usage: node scripts/bundle.mjs [--out <path>]   (default: bundle/server.mjs,
 * relative to apps/server; --out resolves against the caller's CWD).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const { values } = parseArgs({ options: { out: { type: "string" } } });
const outfile = path.resolve(process.cwd(), values.out ?? path.join(here, "../bundle/server.mjs"));

execSync("pnpm exec tsc -b", { cwd: repoRoot, stdio: "inherit" });

await build({
  entryPoints: [path.join(here, "../src/index.ts")],
  outfile,
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
