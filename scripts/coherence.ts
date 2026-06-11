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
 *   [7] Dialect-parallel DDL parity — `sqlite-ddl.ts` and `postgres-ddl.ts`
 *       must declare the same tables, columns, NOT NULL nullability,
 *       table-level constraints, and indexes. Types diverge by design
 *       (INTEGER↔BIGINT, BLOB↔BYTEA) and are deliberately not compared.
 *       ADR 0023 §4 flagged this as a follow-up; the check closes it
 *       until Atlas + kysely-codegen collapse the two files into one.
 *   [8] api-client materialized client type — no lazy `ReturnType<typeof
 *       hc<…>>` alias under `packages/api-client/src/**` (ADR 0028); the
 *       typed-RPC client shape must come from the materialized seam in
 *       `client-type.ts`, never a per-consumer re-instantiation.
 *   [9] Design-token SSOT byte-match — `apps/app/src/styles/{meridian-zero,
 *       themes}.css` must be byte-identical to their `docs/brand/v2/`
 *       origin (ADR 0036/0037). The Web UI ships a self-contained copy of
 *       the token sheets; this fails the commit if a copy drifts from the
 *       SSOT (Biome does not format `.css`, so the bytes stay stable).
 *  [10] ApiErrorCode ↔ errorResponse — the client error vocabulary
 *       (`API_ERROR_CODES` in packages/api-client/src/api-error.ts) must
 *       match exactly the typed `{ error: "…" } as const` envelopes the API
 *       surface emits from `errorResponse` (packages/api-server/src/lib/
 *       errors.ts). The client union is hand-maintained (the kernel erases
 *       the per-route error union behind `hc`, so there is nothing to derive
 *       from); this fails the commit when a new server error class drifts the
 *       two apart. `unauthenticated` + the untyped 5xx family are not typed
 *       client arms and are excluded from both sides by construction.
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

/**
 * Read the architecture spec, which now lives as a folder of section
 * files (`docs/architecture/NN-*.md`, split 2026-05-30). Concatenates
 * them (sorted) so the heading / §6.5 / Appendix A parsers below see one
 * continuous document — section NUMBERS are preserved across the split,
 * so every `§N.M` citation still resolves and the Appendix A table is
 * still locatable. Falls back to the legacy single `docs/architecture.md`
 * if the folder is absent.
 */
async function readArchitectureSource(): Promise<string | null> {
  const dir = join(ROOT, "docs", "architecture");
  if (await pathExists(dir)) {
    const files = (await listMarkdown(dir)).sort();
    if (files.length > 0) {
      const parts = await Promise.all(files.map((f) => readFile(f, "utf8")));
      return parts.join("\n\n");
    }
  }
  return readIfExists(join(ROOT, "docs", "architecture.md"));
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

/**
 * Replace `//` and block-comment bodies with spaces, preserving newlines
 * so reported line numbers stay accurate. Approximate — it does not parse
 * string literals — which is sufficient for scanning TypeScript *type*
 * expressions that never legitimately live inside a string in the files
 * the type-expression checks target. Without it, a check that bans a type
 * pattern would false-positive on prose/JSDoc that names the antipattern.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
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
  const src = await readArchitectureSource();
  if (!src) {
    report.add({
      severity: "warn",
      message: "docs/architecture(.md|/) not found — skipping section ref check",
    });
    return;
  }
  const archDir = join(ROOT, "docs", "architecture");
  const archPath = join(ROOT, "docs", "architecture.md");

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
    if (file === archPath || file.startsWith(`${archDir}/`)) continue; // architecture spec parsed above
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

  // architecture §6.5 contains a `metadata-only set = { … }` code block.
  const archPath = join(ROOT, "docs", "architecture");
  const archSrc = await readArchitectureSource();
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
  kind = "metadata-only",
): void {
  const aSet = new Set(aItems);
  const bSet = new Set(bItems);
  for (const item of aSet) {
    if (!bSet.has(item)) {
      report.add({
        severity: "error",
        message: `${kind} drift: "${item}" in ${aName} but not ${bName}`,
      });
    }
  }
  for (const item of bSet) {
    if (!aSet.has(item)) {
      report.add({
        severity: "error",
        message: `${kind} drift: "${item}" in ${bName} but not ${aName}`,
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
  const archPath = join(ROOT, "docs", "architecture");
  const archSrc = await readArchitectureSource();
  if (!archSrc) {
    report.add({
      severity: "warn",
      message: "docs/architecture(.md|/) not found — skipping Appendix A coherence checks",
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

  // ── Check 5b: system-audit markers must not shadow a real capability ──
  // `SYSTEM_AUDIT_CAPABILITY_IDS` (@editorzero/scopes, ADR 0041) are
  // non-dispatch provenance labels on `audit_events` rows written OUTSIDE the
  // dispatcher (genesis bootstrap; future import / repair jobs). They must
  // stay DISJOINT from the implemented capability ids — a marker that collides
  // with (or later becomes) a registered capability would let a dispatchable
  // id masquerade as a system mutation, or vice versa. Enforces ADR 0041's
  // "reserved, non-dispatchable" guarantee.
  const scopesSrc = await readIfExists(join(ROOT, "packages", "scopes", "src", "index.ts"));
  if (scopesSrc) {
    const implementedById = new Set(implemented.map((i) => i.id));
    for (const marker of parseSystemAuditMarkers(scopesSrc)) {
      if (implementedById.has(marker)) {
        report.add({
          severity: "error",
          message:
            `system-audit marker drift: \`${marker}\` is in SYSTEM_AUDIT_CAPABILITY_IDS ` +
            `(@editorzero/scopes, ADR 0041) but is ALSO implemented as a CapabilityId under ` +
            `packages/capabilities/src/** — a system-audit marker must never be a dispatchable ` +
            `capability. Rename one of them.`,
        });
      }
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
 * Parse the system-audit marker SSOT (`SYSTEM_AUDIT_CAPABILITY_IDS`, ADR 0041)
 * from `@editorzero/scopes` source. The array members are `export const FOO =
 * "x.y"` identifiers; resolve each to its string literal so the disjointness
 * check reflects the real SSOT rather than a duplicated copy. Reading source
 * (not the built dist) keeps coherence build-independent.
 */
function parseSystemAuditMarkers(scopesSrc: string): string[] {
  const arrayMatch = /SYSTEM_AUDIT_CAPABILITY_IDS\s*=\s*\[([^\]]*)\]/.exec(scopesSrc);
  if (arrayMatch?.[1] === undefined) return [];
  const members = arrayMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const markers: string[] = [];
  for (const member of members) {
    const inline = /^"([^"]+)"$/.exec(member);
    if (inline?.[1] !== undefined) {
      markers.push(inline[1]);
      continue;
    }
    // Identifier reference → resolve `export const <ident> = "x.y"`.
    const constMatch = new RegExp(`\\b${member}\\s*=\\s*"([^"]+)"`).exec(scopesSrc);
    if (constMatch?.[1] !== undefined) markers.push(constMatch[1]);
  }
  return markers;
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

// ── Check 7 — Dialect-parallel DDL column parity ──────────────────────────
//
// ADR 0023 §4: `packages/db/src/drivers/sqlite-ddl.ts` and
// `postgres-ddl.ts` carry hand-written dialect-parallel DDL until Atlas +
// kysely-codegen take over. Type mappings diverge by design
// (INTEGER→BIGINT, BLOB→BYTEA), so this check ignores types. What it does
// catch is the drift class that bit the write path for free: a column
// added to one file and forgotten in the other. The integration harness
// would surface that only if a test happened to insert the column;
// here we surface it at commit time even without test coverage.
//
// Parity checked per table:
//   - Same set of column names
//   - Same NOT NULL status per column
//   - Same table-level constraints (UNIQUE / FOREIGN KEY / PRIMARY KEY)
//
// Indexes declared next to a CREATE TABLE (`CREATE [UNIQUE] INDEX … ON
// table(…) [WHERE …]`) are also diffed: index names + full signatures
// (UNIQUE-ness, column list, WHERE predicate) must match between files.
// The partial-unique slug indexes carry their uniqueness *inside* the
// index declaration, so a regex that ignored the UNIQUE keyword and the
// predicate left all five invisible to dialect parity (ADR 0040 H5).
// Both dialects spell these identically, so whitespace-normalized
// string comparison suffices — no SQL parsing.

interface DdlTable {
  readonly name: string;
  readonly columns: Map<string, { notNull: boolean }>;
  readonly constraints: string[];
  readonly indexes: Map<string, string>;
}

async function checkDdlParity(report: Report): Promise<void> {
  const sqlitePath = join(ROOT, "packages", "db", "src", "drivers", "sqlite-ddl.ts");
  const pgPath = join(ROOT, "packages", "db", "src", "drivers", "postgres-ddl.ts");

  const sqliteSrc = await readIfExists(sqlitePath);
  const pgSrc = await readIfExists(pgPath);
  if (sqliteSrc === null || pgSrc === null) {
    report.add({
      severity: "warn",
      message: "sqlite-ddl.ts or postgres-ddl.ts missing — skipping DDL parity check",
    });
    return;
  }

  const sqlite = parseDdl(sqliteSrc);
  const pg = parseDdl(pgSrc);

  const sqliteTableNames = new Set(sqlite.keys());
  const pgTableNames = new Set(pg.keys());

  for (const name of sqliteTableNames) {
    if (!pgTableNames.has(name)) {
      report.add({
        severity: "error",
        file: pgPath,
        message: `DDL parity: table \`${name}\` in sqlite-ddl.ts but missing from postgres-ddl.ts`,
      });
    }
  }
  for (const name of pgTableNames) {
    if (!sqliteTableNames.has(name)) {
      report.add({
        severity: "error",
        file: sqlitePath,
        message: `DDL parity: table \`${name}\` in postgres-ddl.ts but missing from sqlite-ddl.ts`,
      });
    }
  }

  for (const name of sqliteTableNames) {
    if (!pgTableNames.has(name)) continue;
    const s = sqlite.get(name);
    const p = pg.get(name);
    if (!s || !p) continue;

    const sCols = new Set(s.columns.keys());
    const pCols = new Set(p.columns.keys());

    for (const c of sCols) {
      if (!pCols.has(c)) {
        report.add({
          severity: "error",
          file: pgPath,
          message: `DDL parity: \`${name}.${c}\` in sqlite-ddl.ts but missing from postgres-ddl.ts`,
        });
      }
    }
    for (const c of pCols) {
      if (!sCols.has(c)) {
        report.add({
          severity: "error",
          file: sqlitePath,
          message: `DDL parity: \`${name}.${c}\` in postgres-ddl.ts but missing from sqlite-ddl.ts`,
        });
      }
    }

    for (const c of sCols) {
      if (!pCols.has(c)) continue;
      const sNotNull = s.columns.get(c)?.notNull ?? false;
      const pNotNull = p.columns.get(c)?.notNull ?? false;
      if (sNotNull !== pNotNull) {
        report.add({
          severity: "error",
          file: pgPath,
          message:
            `DDL parity: \`${name}.${c}\` NOT NULL differs — ` +
            `sqlite=${sNotNull ? "NOT NULL" : "nullable"}, ` +
            `postgres=${pNotNull ? "NOT NULL" : "nullable"}`,
        });
      }
    }

    const sConstraints = new Set(s.constraints);
    const pConstraints = new Set(p.constraints);
    for (const k of sConstraints) {
      if (!pConstraints.has(k)) {
        report.add({
          severity: "error",
          file: pgPath,
          message: `DDL parity: \`${name}\` constraint \`${k}\` present in sqlite-ddl.ts but not postgres-ddl.ts`,
        });
      }
    }
    for (const k of pConstraints) {
      if (!sConstraints.has(k)) {
        report.add({
          severity: "error",
          file: sqlitePath,
          message: `DDL parity: \`${name}\` constraint \`${k}\` present in postgres-ddl.ts but not sqlite-ddl.ts`,
        });
      }
    }

    for (const [idxName, cols] of s.indexes) {
      const pCols2 = p.indexes.get(idxName);
      if (pCols2 === undefined) {
        report.add({
          severity: "error",
          file: pgPath,
          message: `DDL parity: index \`${idxName}\` on \`${name}\` in sqlite-ddl.ts but missing from postgres-ddl.ts`,
        });
      } else if (pCols2 !== cols) {
        report.add({
          severity: "error",
          file: pgPath,
          message: `DDL parity: index \`${idxName}\` signature differs — sqlite=\`${cols}\`, postgres=\`${pCols2}\``,
        });
      }
    }
    for (const idxName of p.indexes.keys()) {
      if (!s.indexes.has(idxName)) {
        report.add({
          severity: "error",
          file: sqlitePath,
          message: `DDL parity: index \`${idxName}\` on \`${name}\` in postgres-ddl.ts but missing from sqlite-ddl.ts`,
        });
      }
    }
  }
}

/**
 * Parse a `*-ddl.ts` source into `{ tableName → DdlTable }`.
 *
 * Extracts every `CREATE TABLE <name> ( … );` body and every
 * `CREATE [UNIQUE] INDEX <idx> ON <table>(<cols>) [WHERE <pred>];`
 * declaration, then walks the body to split constraint rows (UNIQUE /
 * FOREIGN KEY / PRIMARY KEY) from column rows. Each index is stored as a
 * whitespace-normalized signature — `[UNIQUE ](<cols>)[ WHERE <pred>]` —
 * so uniqueness and partial-index predicates participate in the diff.
 * Types are deliberately not captured — dialect-type divergence is the
 * point of having two files, and types would make this check noisy for
 * every schema touch.
 */
function parseDdl(src: string): Map<string, DdlTable> {
  const out = new Map<string, DdlTable>();

  const tableRe = /CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]*?)\)\s*;/g;
  let tMatch: RegExpExecArray | null = tableRe.exec(src);
  while (tMatch !== null) {
    const name = tMatch[1];
    const body = tMatch[2];
    if (name === undefined || body === undefined) {
      tMatch = tableRe.exec(src);
      continue;
    }
    const { columns, constraints } = parseTableBody(body);
    out.set(name, { name, columns, constraints, indexes: new Map() });
    tMatch = tableRe.exec(src);
  }

  const indexRe =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)(?:\s+WHERE\s+([^;]+))?\s*;/g;
  let iMatch: RegExpExecArray | null = indexRe.exec(src);
  while (iMatch !== null) {
    const unique = iMatch[1]; // optional — undefined for a plain index
    const idxName = iMatch[2];
    const tableName = iMatch[3];
    const cols = iMatch[4];
    const where = iMatch[5]; // optional — undefined for a full index
    if (idxName === undefined || tableName === undefined || cols === undefined) {
      iMatch = indexRe.exec(src);
      continue;
    }
    const table = out.get(tableName);
    if (table) {
      const signature =
        (unique === undefined ? "" : "UNIQUE ") +
        `(${cols.replace(/\s+/g, " ").trim()})` +
        (where === undefined ? "" : ` WHERE ${where.replace(/\s+/g, " ").trim()}`);
      table.indexes.set(idxName, signature);
    }
    iMatch = indexRe.exec(src);
  }

  return out;
}

function parseTableBody(body: string): {
  columns: Map<string, { notNull: boolean }>;
  constraints: string[];
} {
  const columns = new Map<string, { notNull: boolean }>();
  const constraints: string[] = [];

  const lines = splitDdlLines(body);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^(UNIQUE|FOREIGN\s+KEY|PRIMARY\s+KEY|CHECK)\b/i.test(line)) {
      constraints.push(normaliseConstraint(line));
      continue;
    }
    const colMatch = /^(\w+)\s+/.exec(line);
    if (colMatch?.[1]) {
      const colName = colMatch[1];
      const notNull = /\bNOT\s+NULL\b/i.test(line) || /\bPRIMARY\s+KEY\b/i.test(line);
      columns.set(colName, { notNull });
    }
  }

  return { columns, constraints };
}

/**
 * Split a CREATE TABLE body on top-level commas. A naive `.split(",")`
 * would chop inside `FOREIGN KEY (a, b) REFERENCES t(a, b)` lists.
 */
function splitDdlLines(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

/**
 * Collapse whitespace + uppercase keywords so semantically equal
 * constraints that differ only in formatting compare equal.
 */
function normaliseConstraint(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/\bprimary\s+key\b/gi, "PRIMARY KEY")
    .replace(/\bforeign\s+key\b/gi, "FOREIGN KEY")
    .replace(/\bunique\b/gi, "UNIQUE")
    .replace(/\breferences\b/gi, "REFERENCES")
    .replace(/\bon\s+delete\s+cascade\b/gi, "ON DELETE CASCADE")
    .trim();
}

// ── Check 8 — api-client materialized client type (no lazy hc alias) ───────
//
// ADR 0028 (the materialized precompile): `@editorzero/api-client` must source its typed-RPC
// client shape from the materialized `const`-inferred seam in
// `client-type.ts` (the `ApiClient` whose `declare const _client` expands to
// the fully-resolved route tree in declaration emit), never from a lazy
// `ReturnType<typeof hc<AppType>>` alias. tsc preserves that alias unexpanded
// in `.d.ts`, so every consumer re-instantiates the entire route tree
// (`Client<>` / `PathToChain` / `UnionToIntersection`) in its own program —
// the type-checking cost the precompile exists to remove. This bans the lazy
// form anywhere under `packages/api-client/src/**` so the seam cannot
// silently regress to a per-consumer instantiation.

async function checkApiClientMaterializedType(report: Report): Promise<void> {
  const srcDir = join(ROOT, "packages", "api-client", "src");
  if (!(await pathExists(srcDir))) return;

  const files = await listTypeScriptFiles(srcDir);
  const lazyAliasRe = /ReturnType<\s*typeof\s+hc\b/g;
  for (const file of files) {
    const src = stripComments(await readFile(file, "utf8"));
    for (const { match, line } of findMatches(src, lazyAliasRe)) {
      report.add({
        severity: "error",
        file,
        line,
        message:
          `api-client precompile drift: \`${match[0].trim()}…\` — the typed-RPC client shape must ` +
          `come from the materialized \`const\`-inferred seam in client-type.ts (\`ApiClient\`), not ` +
          `the lazy \`ReturnType<typeof hc<…>>\` alias. tsc preserves that alias unexpanded in emit, ` +
          `forcing every consumer to re-instantiate the whole route tree (ADR 0028).`,
      });
    }
  }
}

// ── Check 9 — design-token SSOT byte-match ─────────────────────────────────
//
// The Web UI (`apps/app`) ships a *copy* of the Meridian Zero design-token
// sheets so the bundle is self-contained — no cross-package `@import`
// reaching into `docs/`. The SSOT stays `docs/brand/v2/` (ADR 0036/0037).
// A copy is a duplicate, and duplicates drift, so this fails the commit
// unless each app copy is byte-for-byte identical to its origin. Edit the
// SSOT and re-copy; never hand-edit the copy. Biome does not format `.css`
// (see biome.json `files.includes`), so nothing silently rewrites the bytes.

async function checkDesignTokenCopies(report: Report): Promise<void> {
  const sheets = ["meridian-zero.css", "themes.css"];
  for (const name of sheets) {
    const ssot = join(ROOT, "docs", "brand", "v2", name);
    const copy = join(ROOT, "apps", "app", "src", "styles", name);
    const copySrc = await readIfExists(copy);
    // Binds only once the app copy exists; before the Web UI styles slice
    // there is nothing to drift against, so skip silently.
    if (copySrc === null) continue;
    const ssotSrc = await readIfExists(ssot);
    if (ssotSrc === null) {
      report.add({
        severity: "error",
        file: copy,
        message:
          `design-token SSOT missing: ${relative(ROOT, copy)} exists but its source ` +
          `${relative(ROOT, ssot)} does not — restore the SSOT (the app sheet is a copy).`,
      });
      continue;
    }
    if (ssotSrc !== copySrc) {
      report.add({
        severity: "error",
        file: copy,
        message:
          `design-token drift: ${relative(ROOT, copy)} is not byte-identical to its SSOT ` +
          `${relative(ROOT, ssot)} (ADR 0036/0037). Re-copy from the SSOT; never hand-edit the copy.`,
      });
    }
  }
}

// ── Check 10 — ApiErrorCode ↔ errorResponse typed envelope ─────────────────
//
// `API_ERROR_CODES` (packages/api-client/src/api-error.ts) is the client
// projection of the typed `{ error: code }` envelopes the API surface emits
// from `errorResponse` (packages/api-server/src/lib/errors.ts). It is
// hand-maintained — the kernel erases the per-route error union behind `hc`, so
// there is no single type to derive from — and a hand-maintained mirror drifts:
// add a 14th `EditorZeroError` subclass + envelope and the client union
// silently lags. This fails the commit when the two SETS diverge (order is not
// compared). `unauthenticated` (the middleware 401) and the untyped 5xx family
// are not typed client arms; `errorResponse` never emits them via a
// `c.json({ error } as const)` line, so they are excluded from both sides by
// construction.

async function checkApiErrorCodes(report: Report): Promise<void> {
  const clientPath = join(ROOT, "packages", "api-client", "src", "api-error.ts");
  const serverPath = join(ROOT, "packages", "api-server", "src", "lib", "errors.ts");
  const clientSrc = await readIfExists(clientPath);
  const serverSrc = await readIfExists(serverPath);
  if (clientSrc === null || serverSrc === null) {
    report.add({
      severity: "warn",
      message: "api-error.ts or errors.ts not found — skipping ApiErrorCode coherence check",
    });
    return;
  }

  const clientCodes = parseApiErrorCodes(clientSrc);
  if (clientCodes === null) {
    report.add({
      severity: "error",
      file: clientPath,
      message:
        "API_ERROR_CODES export not parseable — expected `export const API_ERROR_CODES = [ ... ] as const`",
    });
    return;
  }

  const serverCodes = parseServerErrorEnvelopes(serverSrc);
  if (serverCodes.length === 0) {
    report.add({
      severity: "error",
      file: serverPath,
      message:
        'no `c.json({ error: "…" } as const, …)` envelopes found in errors.ts — check errorResponse',
    });
    return;
  }

  diffLists(
    report,
    "packages/api-server errors.ts",
    serverCodes,
    "packages/api-client API_ERROR_CODES",
    clientCodes,
    "ApiErrorCode",
  );
}

function parseApiErrorCodes(src: string): string[] | null {
  const re = /export\s+const\s+API_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/;
  const m = re.exec(src);
  if (!m?.[1]) return null;
  return extractStringItems(m[1]);
}

/**
 * Pull every `{ error: "code" } as const` envelope literal out of
 * `errorResponse`. That exact shape is the only one `hc` infers as a typed
 * client error arm (ADR 0029 §4); `errEnvelope("unauthenticated")` lives in a
 * `describeRoute` declaration (whoami.ts), not here, and rethrown 5xx never
 * take this form — so the match set is exactly the typed client arms.
 */
function parseServerErrorEnvelopes(src: string): string[] {
  // `[a-z][a-z0-9_]*` matches the canonical identifier alphabet the sibling
  // parsers already use (CapabilityId literals, audit-effect kinds, Appendix A
  // rows) — digits-after-first allowed. The client-side `extractStringItems`
  // accepts any quoted string, so a narrower class here would FALSE-POSITIVE on
  // a future digit-bearing code (e.g. `oauth2_denied`) mirrored correctly in
  // both files — a phantom drift that blocks a correct commit (review finding).
  const re = /\{\s*error:\s*"([a-z][a-z0-9_]*)"\s*\}\s*as\s+const/g;
  const out: string[] = [];
  for (const { match } of findMatches(src, re)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
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
    checkDdlParity(report),
    checkApiClientMaterializedType(report),
    checkDesignTokenCopies(report),
    checkApiErrorCodes(report),
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
