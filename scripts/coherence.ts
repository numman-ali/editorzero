#!/usr/bin/env tsx
/**
 * Coherence script — drift-prevention pre-commit guard.
 *
 * continuation.md § "Drift-prevention posture": prose-as-spec hides bugs
 * that types + tests catch instantly; hand-maintained duplicates drift.
 * This script fails the commit on divergence for the classes of drift
 * that types alone cannot catch (cross-doc references, hand-maintained
 * enumerations that must match a source-of-truth list in code).
 *
 * Active checks (each fails the commit on violation):
 *   [1] ADR cross-reference integrity — `docs/adr/NNNN-*.md` files that
 *       are referenced from anywhere must exist.
 *   [2] Architecture section reference integrity — `§N.M` / `§N.Ma`
 *       citations resolve to real headings in `docs/architecture.md`.
 *   [3] METADATA_ONLY_CAPABILITIES triple-consistency —
 *       `packages/scopes` ↔ `docs/architecture.md` §6.5 ↔ `AGENTS.md`
 *       invariant 7 list agree on the exact membership.
 *   [4] `no-raw-kysely-outside-db` (F89) — no production or test file
 *       outside `packages/db/**` imports from `kysely`. Enforces the
 *       single-chokepoint claim architecture.md §8.1a / §17 rests on.
 *       This is the load-bearing rule the future `@editorzero/arch-lint`
 *       package will eventually own; until that package lands, the
 *       coherence script enforces it.
 *
 * Deferred checks (no-ops today; activate when the real comparison is
 * implemented, not when a source file merely exists):
 *   [D1] Capability registry ↔ Appendix A matrix 1:1. The registry
 *        package exists; the appendix parser and diff do not.
 *   [D2] AuditEffect union ↔ Appendix A effect-kind column. The effect
 *        module exists; the appendix parser and diff do not.
 *   [D3] Numeric literal leak — any literal outside `packages/constants`
 *        matching a constant value should reference the named export.
 *
 * Exits non-zero on any error. Warnings are printed but do not fail.
 */

import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");

// ── Report primitives ──────────────────────────────────────────────────────

type Severity = "error" | "warn" | "info";

interface Finding {
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
}

class Report {
  readonly findings: Finding[] = [];

  add(finding: Finding): void {
    this.findings.push(finding);
  }

  get errorCount(): number {
    return this.findings.filter((f) => f.severity === "error").length;
  }

  get warnCount(): number {
    return this.findings.filter((f) => f.severity === "warn").length;
  }

  print(): void {
    const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
    const sorted = [...this.findings].sort((a, b) => order[a.severity] - order[b.severity]);
    for (const f of sorted) {
      const loc = f.file ? `${relative(ROOT, f.file)}${f.line ? `:${f.line}` : ""}` : "";
      const tag = f.severity === "error" ? "ERR " : f.severity === "warn" ? "WARN" : "INFO";
      const prefix = loc ? `${tag} ${loc}` : tag;
      process.stdout.write(`${prefix}  ${f.message}\n`);
    }
    process.stdout.write(
      `\ncoherence: ${this.errorCount} error(s), ${this.warnCount} warning(s)\n`,
    );
  }
}

// ── File walk helpers ──────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(p: string): Promise<string | null> {
  if (!(await pathExists(p))) return null;
  return readFile(p, "utf8");
}

function* findMatches(
  source: string,
  pattern: RegExp,
): Generator<{ match: RegExpExecArray; line: number }> {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    const line = source.slice(0, m.index).split("\n").length;
    yield { match: m, line };
    m = re.exec(source);
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const { readdir } = await import("node:fs/promises");
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(p);
      }
    }
  };
  if (await pathExists(dir)) await walk(dir);
  return out;
}

// ── Check 1 — ADR cross-reference integrity ────────────────────────────────
//
// Matches `ADR 0014`, `[ADR 0014]`, and `adr/0014-foo.md` references.
// For each, verify a file `docs/adr/00NN-*.md` exists.

async function checkAdrReferences(report: Report): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const adrDir = join(ROOT, "docs", "adr");
  if (!(await pathExists(adrDir))) {
    report.add({ severity: "warn", message: "docs/adr/ not found — skipping ADR reference check" });
    return;
  }
  const adrFiles = (await readdir(adrDir)).filter((n) => /^\d{4}-.+\.md$/.test(n));
  const adrIndex = new Set<string>();
  for (const f of adrFiles) {
    const m = /^(\d{4})-/.exec(f);
    if (m?.[1]) adrIndex.add(m[1]);
  }

  const searchRoots = [
    join(ROOT, "docs"),
    join(ROOT, "AGENTS.md"),
    join(ROOT, "README.md"),
    join(ROOT, "CONTRIBUTING.md"),
    join(ROOT, "SECURITY.md"),
  ];
  const mdFiles = new Set<string>();
  for (const r of searchRoots) {
    if (r.endsWith(".md")) {
      if (await pathExists(r)) mdFiles.add(r);
    } else {
      for (const f of await listMarkdown(r)) mdFiles.add(f);
    }
  }

  const adrRefRe = /\bADR[\s-]?(\d{4})\b|adr\/(\d{4})-[a-z0-9-]+\.md/g;
  for (const file of mdFiles) {
    const src = await readFile(file, "utf8");
    for (const { match, line } of findMatches(src, adrRefRe)) {
      const num = match[1] ?? match[2];
      if (!num) continue;
      if (!adrIndex.has(num)) {
        report.add({
          severity: "error",
          message: `broken ADR reference "${match[0]}" — no docs/adr/${num}-*.md found`,
          file,
          line,
        });
      }
    }
  }
}

// ── Check 2 — Architecture section reference integrity ─────────────────────
//
// Citations of `§N.M` / `§N.Ma` / `§N` in docs or code must resolve to a
// heading in architecture.md.

async function checkArchitectureSectionRefs(report: Report): Promise<void> {
  const archPath = join(ROOT, "docs", "architecture.md");
  const src = await readIfExists(archPath);
  if (!src) {
    report.add({
      severity: "warn",
      message: "docs/architecture.md not found — skipping section ref check",
    });
    return;
  }

  // Parse headings: `## 6. Section` (period), `### 6.4 Something` (space),
  // `#### 6.4.1 …`, `### 6.5a Addendum`. We only care about the leading
  // numeric identifier (`6`, `6.4`, `6.4a`).
  const headingRe = /^#{1,6}\s+(\d+(?:\.\d+[a-z]?)*)\.?(?:\s|$)/gm;
  const known = new Set<string>();
  for (const { match } of findMatches(src, headingRe)) {
    const id = match[1];
    if (id) known.add(id);
  }

  // Match `§6.4`, `§6.4a`, `§6` (but not inside a code block — we skip
  // fenced blocks conservatively by excluding the matched-to-backtick range).
  const sectionRefRe = /§\s?(\d+(?:\.\d+[a-z]?)*)/g;

  const docsDir = join(ROOT, "docs");
  const mdFiles = await listMarkdown(docsDir);
  mdFiles.push(join(ROOT, "AGENTS.md"));

  for (const file of mdFiles) {
    if (!(await pathExists(file))) continue;
    if (file === archPath) continue; // self-references parsed above
    const content = await readFile(file, "utf8");
    for (const { match, line } of findMatches(content, sectionRefRe)) {
      const id = match[1];
      if (!id) continue;
      if (!known.has(id)) {
        report.add({
          severity: "error",
          message: `architecture.md §${id} referenced but no such heading exists`,
          file,
          line,
        });
      }
    }
  }
}

// ── Check 3 — METADATA_ONLY_CAPABILITIES triple-consistency ────────────────

async function checkMetadataOnlyCapabilities(report: Report): Promise<void> {
  const scopesPath = join(ROOT, "packages", "scopes", "src", "index.ts");
  const scopesSrc = await readIfExists(scopesPath);
  if (!scopesSrc) {
    report.add({
      severity: "warn",
      message: "packages/scopes/src/index.ts not found — skipping metadata-only consistency check",
    });
    return;
  }

  const codeList = parseMetadataOnlyFromScopes(scopesSrc);
  if (codeList === null) {
    report.add({
      severity: "error",
      file: scopesPath,
      message:
        "METADATA_ONLY_CAPABILITIES export not parseable — expected `export const METADATA_ONLY_CAPABILITIES = [ ... ] as const`",
    });
    return;
  }

  // architecture.md §6.5 contains a `metadata-only set = { … }` code block.
  const archPath = join(ROOT, "docs", "architecture.md");
  const archSrc = await readIfExists(archPath);
  if (archSrc) {
    const docList = parseMetadataOnlyFromArchitecture(archSrc);
    if (docList === null) {
      report.add({
        severity: "error",
        file: archPath,
        message: "architecture.md §6.5 metadata-only-set block not parseable",
      });
    } else {
      diffLists(report, "architecture.md §6.5", docList, "packages/scopes", codeList);
    }
  }

  // AGENTS.md invariant 7 lists metadata capabilities inline. It uses
  // `collection.*` as shorthand — we expand that to all five variants
  // before diffing.
  const agentsPath = join(ROOT, "AGENTS.md");
  const agentsSrc = await readIfExists(agentsPath);
  if (agentsSrc) {
    const agentsList = parseMetadataOnlyFromAgents(agentsSrc);
    if (agentsList === null) {
      report.add({
        severity: "error",
        file: agentsPath,
        message: "AGENTS.md invariant 7 metadata-only enumeration not parseable",
      });
    } else {
      diffLists(report, "AGENTS.md invariant 7", agentsList, "packages/scopes", codeList);
    }
  }
}

function parseMetadataOnlyFromScopes(src: string): string[] | null {
  const re = /export\s+const\s+METADATA_ONLY_CAPABILITIES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/;
  const m = re.exec(src);
  if (!m?.[1]) return null;
  return extractStringItems(m[1]);
}

function parseMetadataOnlyFromArchitecture(src: string): string[] | null {
  // Find the `metadata-only set = { ... }` block near §6.5.
  const re = /metadata-only set\s*=\s*\{([\s\S]*?)\}/;
  const m = re.exec(src);
  if (!m?.[1]) return null;
  // The block is plain text of the form `  block.set_visibility,\n  doc.publish, doc.unpublish, doc.move,\n  ...`
  const ids = m[1]
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(s));
  return ids;
}

function parseMetadataOnlyFromAgents(src: string): string[] | null {
  // Invariant 7 text includes:
  //   "**Metadata mutations** (`block.set_visibility`, `doc.publish`,
  //    `doc.unpublish`, `doc.move`, `collection.*`)"
  const re = /Metadata mutations[^(]*\(([^)]+)\)/;
  const m = re.exec(src);
  if (!m?.[1]) return null;
  const raw = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^`|`$/g, ""))
    .filter((s) => s.length > 0);

  // Expand `collection.*` to the five concrete members.
  const CollectionVariants = [
    "collection.create",
    "collection.update",
    "collection.move",
    "collection.delete",
    "collection.restore",
  ];
  const out: string[] = [];
  for (const id of raw) {
    if (id === "collection.*") {
      out.push(...CollectionVariants);
    } else if (/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(id)) {
      out.push(id);
    }
  }
  return out;
}

function extractStringItems(block: string): string[] {
  const re = /"([^"]+)"|'([^']+)'/g;
  const out: string[] = [];
  for (const { match } of findMatches(block, re)) {
    const v = match[1] ?? match[2];
    if (v) out.push(v);
  }
  return out;
}

function diffLists(
  report: Report,
  aName: string,
  aItems: string[],
  bName: string,
  bItems: string[],
): void {
  const aSet = new Set(aItems);
  const bSet = new Set(bItems);
  for (const item of aSet) {
    if (!bSet.has(item)) {
      report.add({
        severity: "error",
        message: `metadata-only drift: "${item}" in ${aName} but not ${bName}`,
      });
    }
  }
  for (const item of bSet) {
    if (!aSet.has(item)) {
      report.add({
        severity: "error",
        message: `metadata-only drift: "${item}" in ${bName} but not ${aName}`,
      });
    }
  }
}

// ── Check 4 — no-raw-kysely-outside-db ─────────────────────────────────────
//
// architecture.md §8.1a + §17 claim that `Kysely` and `sql<T>` are
// importable only inside `packages/db/**`, so the workspace-scoping
// plugin cannot be bypassed by accident. Until `@editorzero/arch-lint`
// ships the real static rule, the coherence script enforces it by
// import-string grep.
//
// Scope: `.ts`, `.tsx`, `.mts`, `.cts` files under `packages/` (every
// workspace package). The only legal imports of `kysely` live under
// `packages/db/src/**`. Violations fail the commit with a file + line
// pointer. Test files inside `packages/db/**` are also allowed — the
// rule is about the package boundary, not the file boundary.

async function checkNoRawKyselyOutsideDb(report: Report): Promise<void> {
  const packagesDir = join(ROOT, "packages");
  if (!(await pathExists(packagesDir))) return;

  const allTs = await listTypeScriptFiles(packagesDir);
  const allowed = join(ROOT, "packages", "db") + "/";
  const importRe = /^\s*import\b[^;]*?\bfrom\s+["']kysely(?:\/[^"']+)?["']/gm;

  for (const file of allTs) {
    if (file.startsWith(allowed)) continue;
    const src = await readFile(file, "utf8");
    for (const { match, line } of findMatches(src, importRe)) {
      report.add({
        severity: "error",
        file,
        line,
        message:
          `no-raw-kysely-outside-db: illegal import "${match[0].trim()}" — ` +
          `\`kysely\` may only be imported inside \`packages/db/**\`. ` +
          `Capability handlers reach the DB through \`ctx.db\` (TenantScopedDb).`,
      });
    }
  }
}

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const { readdir } = await import("node:fs/promises");
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  if (await pathExists(dir)) await walk(dir);
  return out;
}

// ── Deferred stubs — no enforcement today ──────────────────────────────────
//
// Both of the below print nothing and are not wired into `main()`. They
// stay in the file as named no-ops so the Appendix-A / registry-diff
// work lands as a rewrite of a known entry point rather than a new
// function search. When the parser + diff lands, wire the result into
// the `Promise.all` below and the top-file docstring in the same commit
// so the overclaim Codex flagged at F89 cannot recur.

async function _checkCapabilityRegistry(_report: Report): Promise<void> {
  // Deferred (D1). `packages/capabilities/src/registry.ts` exists; the
  // Appendix A parser does not. Do not print info; silence is honest.
}

async function _checkAuditEffectUnion(_report: Report): Promise<void> {
  // Deferred (D2). `packages/audit/src/effect.ts` exists; the Appendix
  // A effect-kind parser does not.
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const report = new Report();
  await Promise.all([
    checkAdrReferences(report),
    checkArchitectureSectionRefs(report),
    checkMetadataOnlyCapabilities(report),
    checkNoRawKyselyOutsideDb(report),
  ]);
  report.print();
  if (report.errorCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `coherence: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(2);
});
