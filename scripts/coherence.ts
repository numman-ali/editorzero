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
 *   [3] METADATA_ONLY_CAPABILITIES consistency —
 *       `packages/scopes` ↔ `docs/architecture.md` §6.5 agree on the
 *       exact membership. (AGENTS.md invariant 7 references the scopes
 *       export by name rather than enumerating — AGENTS.md is
 *       agent-loading context, not a derived artifact.)
 *   [4] `no-raw-kysely-outside-db` (F89) — no production or test file
 *       outside `packages/db/**` imports from `kysely`. Enforces the
 *       single-chokepoint claim architecture.md §8.1a / §17 rests on.
 *       This is the load-bearing rule the future `@editorzero/arch-lint`
 *       package will eventually own; until that package lands, the
 *       coherence script enforces it.
 *   [5] Implemented capability ↔ Appendix A matrix. Every
 *       `CapabilityId("x.y")` literal under `packages/capabilities/src/**`
 *       (non-test) must appear as a row in architecture.md § Appendix A.
 *       Asymmetric: Appendix A may list forward-looking capabilities not
 *       yet implemented — that's expected until Phase 4 backfill — but
 *       an implemented capability absent from the matrix is drift.
 *   [6] Implemented capability's Appendix A effect kind ↔ AuditEffect
 *       variant. For every row in [5], the Appendix A "Audit effect
 *       kind" column value (the rightmost cell of that row) must either
 *       be the category literal `read` (collapsible or otherwise) or
 *       name a `kind: "…"` variant declared in
 *       `packages/audit/src/effect.ts`. Catches the class of drift where
 *       a capability ships, Appendix A names a fresh effect kind, but
 *       the discriminated union never gains the variant — which would
 *       silently make the audit writer fall through to `{ kind:
 *       "internal" }` (F95) without a compile-time error.
 *
 * Deferred checks (no-ops today; activate when the real comparison is
 * implemented, not when a source file merely exists):
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
  const allowed = `${join(ROOT, "packages", "db")}/`;
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

// ── Check 5 + 6 — Appendix A ↔ registry + AuditEffect ──────────────────────
//
// Single parsing pass that powers both checks: scan architecture.md's
// `## Appendix A — Capability matrix` table, extract each row's
// capability id (first column) and audit effect cell (last column),
// then diff against the two code sources of truth:
//
//   [5] `CapabilityId("x.y")` literals under packages/capabilities/src/**
//       (non-test). The implemented set.
//   [6] `kind: "…"` variants in packages/audit/src/effect.ts. The
//       permitted audit-effect-kind set.
//
// Asymmetry by design:
//   - Appendix A is forward-looking; it may list capabilities not yet
//     implemented. So (5) fails only when an IMPLEMENTED capability is
//     absent from Appendix A — the other direction (matrix-extra) is
//     silent until Phase 4 backfills capabilities.
//   - Appendix A's effect column may say `read` (category marker, not a
//     kind); reads audit as `audit.access_log` (§9.3). We accept `read`
//     and variants thereof (e.g. `read (collapsible)`, `read (enqueues
//     job)`) as "the access_log path"; only non-`read` values are
//     checked against the `AuditEffect` union. (6) fails when an
//     Appendix A row names an effect kind that isn't in the union,
//     because that is exactly the drift shape that would make the audit
//     writer fall through to `{ kind: "internal" }` (F95) at runtime
//     without a compile-time signal.

interface AppendixRow {
  capability_id: string;
  audit_effect_raw: string; // full last-cell text (may carry annotations)
  line: number;
}

async function checkAppendixACoherence(report: Report): Promise<void> {
  const archPath = join(ROOT, "docs", "architecture.md");
  const archSrc = await readIfExists(archPath);
  if (!archSrc) {
    report.add({
      severity: "warn",
      message: "docs/architecture.md not found — skipping Appendix A coherence checks",
    });
    return;
  }

  const rows = parseAppendixARows(archSrc);
  if (rows === null) {
    report.add({
      severity: "error",
      file: archPath,
      message: "Appendix A table not locatable — expected '## Appendix A — Capability matrix'",
    });
    return;
  }

  // ── Check 5: implemented capabilities must appear in Appendix A ────────
  const capsDir = join(ROOT, "packages", "capabilities", "src");
  const implemented = await collectImplementedCapabilityIds(capsDir);
  const appendixIds = new Set(rows.map((r) => r.capability_id));
  for (const impl of implemented) {
    if (!appendixIds.has(impl.id)) {
      report.add({
        severity: "error",
        file: impl.file,
        line: impl.line,
        message:
          `Appendix A drift: \`${impl.id}\` is implemented (CapabilityId literal) but has no row in ` +
          `docs/architecture.md § Appendix A. Add a matrix row with scopes/surfaces/rate/effect, ` +
          `or rename the implementation to match an existing row.`,
      });
    }
  }

  // ── Check 6: Appendix A effect kinds must exist in AuditEffect ─────────
  const effectPath = join(ROOT, "packages", "audit", "src", "effect.ts");
  const effectSrc = await readIfExists(effectPath);
  if (!effectSrc) {
    report.add({
      severity: "warn",
      message:
        "packages/audit/src/effect.ts not found — skipping AuditEffect-union coherence check",
    });
    return;
  }
  const unionKinds = parseAuditEffectKinds(effectSrc);
  if (unionKinds.size === 0) {
    report.add({
      severity: "error",
      file: effectPath,
      message:
        'AuditEffect union: no `kind: "…"` variants parseable — check the file is structured as a discriminated union',
    });
    return;
  }

  for (const row of rows) {
    const extracted = extractEffectKindFromCell(row.audit_effect_raw);
    if (extracted === null) continue; // `read` family — category marker, not a kind
    if (!unionKinds.has(extracted)) {
      report.add({
        severity: "error",
        file: archPath,
        line: row.line,
        message:
          `Appendix A drift: row \`${row.capability_id}\` audits as \`${extracted}\` but that kind ` +
          `is not a variant of \`AuditEffect\` in packages/audit/src/effect.ts. Either add the ` +
          `variant to the union (with replay-reducer branch) or fix the matrix to name an ` +
          `existing kind.`,
      });
    }
  }
}

/**
 * Locate the Appendix A table and extract each row's capability id +
 * last-cell (audit effect) text. Returns `null` if the heading is
 * missing — the heading presence is the signal the appendix still
 * lives in this doc under the expected anchor.
 */
function parseAppendixARows(src: string): AppendixRow[] | null {
  const headingRe = /^##\s+Appendix A\b.*$/m;
  const headingMatch = headingRe.exec(src);
  if (!headingMatch) return null;

  // The appendix ends at the next top-level `##` heading or end-of-doc.
  const after = src.slice(headingMatch.index + headingMatch[0].length);
  const nextTopRe = /^##\s+(?!Appendix A)/m;
  const nextTopMatch = nextTopRe.exec(after);
  const appendixBody = nextTopMatch ? after.slice(0, nextTopMatch.index) : after;

  const rowRe = /^\|\s+`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`/gm;
  const out: AppendixRow[] = [];
  let m: RegExpExecArray | null = rowRe.exec(appendixBody);
  while (m !== null) {
    const rowStart = m.index;
    const lineEnd = appendixBody.indexOf("\n", rowStart);
    const rowText = appendixBody.slice(rowStart, lineEnd === -1 ? undefined : lineEnd);
    // Last `|` separates the Audit-effect-kind cell from the trailing `|`.
    const cells = rowText.split("|").map((c) => c.trim());
    // Trailing empty cell from the final `|`; audit cell is cells[cells.length - 2].
    const last = cells[cells.length - 2] ?? "";
    const line = src
      .slice(0, headingMatch.index + headingMatch[0].length + rowStart)
      .split("\n").length;
    // biome-ignore lint/style/noNonNullAssertion: regex capture group 1 is required by the pattern
    out.push({ capability_id: m[1]!, audit_effect_raw: last, line });
    m = rowRe.exec(appendixBody);
  }
  return out;
}

/**
 * Pull every `CapabilityId("x.y")` literal out of
 * packages/capabilities/src/**, skipping test files. Each literal
 * is treated as "an implemented capability surface exists for id
 * x.y"; duplicates across files are collapsed in the returned set.
 */
interface ImplementedId {
  id: string;
  file: string;
  line: number;
}

async function collectImplementedCapabilityIds(dir: string): Promise<ImplementedId[]> {
  if (!(await pathExists(dir))) return [];
  const files = await listTypeScriptFiles(dir);
  const literalRe = /CapabilityId\(\s*"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"\s*\)/g;
  const out: ImplementedId[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    // Skip test files — CapabilityId literals inside fixtures aren't
    // claims about shipped capabilities.
    if (/\.(unit|integration|prop|contract|e2e)\.test\.(ts|tsx|mts|cts)$/.test(file)) continue;
    const src = await readFile(file, "utf8");
    for (const { match, line } of findMatches(src, literalRe)) {
      const id = match[1];
      if (id === undefined) continue;
      const key = `${id}::${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, file, line });
    }
  }
  return out;
}

/**
 * Parse the `kind: "…"` literal set from `packages/audit/src/effect.ts`.
 * The file is a `export type AuditEffect = | { kind: "…"; … } | …` union,
 * and **only** the top-level `kind:` discriminator field contributes.
 * A negative-lookbehind rejects matches like `subject_kind: "user"` or
 * `index_kind: "fts"` on nested-property fields — without it, Appendix A
 * could silently type an effect as `user` / `fts` / `role` and this
 * check would accept the drift (Codex F106 P3).
 */
function parseAuditEffectKinds(src: string): Set<string> {
  const re = /(?<![A-Za-z_])kind\s*:\s*"([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)"/g;
  const out = new Set<string>();
  for (const { match } of findMatches(src, re)) {
    if (match[1]) out.add(match[1]);
  }
  return out;
}

/**
 * Pull the canonical effect-kind id out of an Appendix A "Audit effect
 * kind" cell. Returns `null` for the `read` family (category marker,
 * not a variant in `AuditEffect`). Otherwise returns the first
 * backticked `x.y` token, stripping parenthesized annotations such as
 * `(full preimage)`, `(collapsible)`, `(post-reconcile)`.
 */
function extractEffectKindFromCell(cell: string): string | null {
  const stripped = cell.replace(/\([^)]*\)/g, "").trim();
  // `read`, `read (collapsible)`, `read (enqueues job)` all reduce to
  // just `read` after annotation stripping.
  if (/^read\b/i.test(stripped)) return null;
  const backtickRe = /`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`/;
  const m = backtickRe.exec(stripped);
  if (!m?.[1]) return null;
  return m[1];
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const report = new Report();
  await Promise.all([
    checkAdrReferences(report),
    checkArchitectureSectionRefs(report),
    checkMetadataOnlyCapabilities(report),
    checkNoRawKyselyOutsideDb(report),
    checkAppendixACoherence(report),
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
