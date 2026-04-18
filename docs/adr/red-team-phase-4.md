# Red-team pass #4 on implementation (Phase 3 foundational layer)

**Date:** 2026-04-18
**Target:** Phase 3 code-as-landed — foundational packages + dispatcher + db Layer-2 + first real capability (`doc.list`).
**Reviewer:** Codex, invited by @numman with an open-scope principal-engineer prompt ("check composition, audit plan vs reality, repo hygiene; do not narrow sight").
**Disposition author:** primary agent (Opus 4.7).

## Context

Passes 1–3 targeted `docs/architecture.md`. This is the first pass against *landed code*. The prompt explicitly asked for a plan-vs-reality check: where has the code drifted silently from the architecture, and where is the architecture claiming guarantees the code doesn't yet hold. The bar was set by prior passes' finds.

## Summary

**11 findings: 3 BLOCKER, 4 HIGH, 1 MEDIUM, 1 LOW, 4 UNUSUAL-GOOD.**

Headline: the three BLOCKERs are all "claim true in prose, not yet true in code." The typecheck-hole-closed commit I landed the prior day (`e72970f`) is itself an instance of this: the new `tsconfig.test.json` files are real, but the pre-commit hook doesn't invoke them, so the coverage is illusory. The cross-tenant leak and the plugin alias/join gaps are the same shape of problem — the invariant the architecture claims is not structurally enforced by the code. Fixing them is the next three commits before any further capability lands.

## Numbering

Continuing the F-series: F85–F95.

## Disposition

| ID | Severity | Title | Disposition | Applied |
|---|---|---|---|---|
| F85 | **BLOCKER** | Typecheck hole not actually closed — hook calls `exec tsc -b`, skipping per-package `tsconfig.test.json`; root `tsconfig.json` missing `dispatcher` + `db` references | Accepted → Applied | 2026-04-18 `ec5f46f` |
| F86 | **BLOCKER** | Cross-tenant read possible — `DispatchInvocation.principal`, `.tenant`, `.access` are independent, so Layer 1 can authorize A while Layer 2 reads B | Accepted → Applied | 2026-04-18 `7c748cd` |
| F87 | **BLOCKER** | `WorkspaceScopingPlugin` is neither alias-aware nor join-aware — aliased tables emit invalid SQL (`no such column: docs.workspace_id`); JOINed tenant tables never get the predicate | Accepted → Applied | 2026-04-18 (pending commit) |
| F88 | HIGH | Post-parse deny has no audit path — `PermissionDeniedError` thrown from a handler is rethrown without a deny row; comment claims "handler emits its own deny audit" but handlers have no audit writer | Accepted | Pending |
| F89 | HIGH | Coherence script + `@editorzero/arch-lint` described as present-tense enforcement, but key checks are stubs and the arch-lint package doesn't exist | Accepted | Pending |
| F90 | HIGH | `AuditWriteInput` is narrower than the audit schema — no `category`, no `collapsed_count`; `input_hash` computed as 32-bit FNV but architecture says normalized sha256 | Accepted | Pending |
| F91 | HIGH | SQLite driver skips ADR 0007's runtime pragmas (WAL, `foreign_keys`, `synchronous`, busy timeout, etc.) — tests and load work exercise a different SQLite than the architecture sizes | Accepted | Pending |
| F92 | MEDIUM | Architecture claims runtime "`ctx.transact` at most once" backstop, but kernel is a plain function type; first content mutation can split one logical write into multiple transacts silently | Accepted | Pending |
| F93 | LOW | `doc.list` hardcodes 1000ms collapse window instead of `AUDIT_READ_COLLAPSE_WINDOW_MS` — constants-as-SSOT principle slipping at exemplar code | Accepted | Pending |
| F94 | UNUSUAL-GOOD | Closure-based `RegisteredCapability` erasure avoids boundary casts in a heterogeneous registry | Defend | n/a |
| F95 | UNUSUAL-GOOD | Each `EditorZeroError` subclass owns its audit projection via abstract `toHandlerError()` — scalable correctness vs the usual central string-code switch | Defend | n/a |
| F96 | UNUSUAL-GOOD | Registry-first, adapters-derived, parity-enforced-by-contract is the right center of gravity for "AI-native across four surfaces" | Defend | n/a |
| F97 | UNUSUAL-GOOD | ADR 0007 declares a SQLite envelope instead of pretending dual-backend parity is free — honest technical leadership | Defend | n/a |

## Fix order + rationale

1. **F85 first.** Without real typecheck coverage across the whole graph, subsequent fixes (F86, F87) could themselves land with silent test-file type errors. The hole is the meta-problem; closing it is the prerequisite for every other fix to be verifiable.
2. **F86.** Structural dispatcher change. Independent of F87.
3. **F87.** Plugin rewrite. Independent of F86.
4. **F88.** Dispatcher catch-block change; depends on F86 having stabilized the `DispatchInvocation` shape.
5. **F89.** Doc language + minimum-viable enforcement surfaces. Interleave-friendly.
6. **F90.** Widen `AuditWriteInput`; swap FNV for sha256. Interacts with F88.
7. **F91.** Driver-only change. Isolated.
8. **F92.** Dispatcher-side wrapper on `ctx.transact` building ctx.
9. **F93.** One-line change.

Each fix lands as one commit with a self-describing message. After each commit, update this file's "Applied" column with `YYYY-MM-DD <sha>`.

## Fix sketches (directional, not prescriptive)

- **F85.** Add `packages/dispatcher` + `packages/db` to root `tsconfig.json` references. Change `typecheck:affected` from `pnpm -r … exec tsc -b` to `pnpm -r … run typecheck` so per-package scripts (which include `tsc -b` + `tsc --noEmit -p tsconfig.test.json`) are what actually runs in the hook. Verify empirically: plant a type error in a test file, run the hook, confirm fail, revert.
- **F86.** Remove `tenant` from `DispatchInvocation`. Derive `tenant = { workspace_id: principal.workspace_id }` inside `dispatch()`. Assert `access.workspace_id === principal.workspace_id` at entry (throw on mismatch). Change `makeContextExtras(principal, tenant)` → `makeContextExtras(principal)` so the db scope can only come from principal. Add a test that constructs mismatched principal/access and watches dispatch reject.
- **F87.** Rewrite the transformer to:
  - Traverse `joins` alongside `from.froms` for SELECT and DELETE.
  - Track tenant-scoped table occurrences as `{ tableNode, refNode }` pairs where `refNode` is the alias when present, the table otherwise.
  - Build predicates against `refNode` so aliased SQL is legal.
  - Add tests: aliased self-join, multi-table join mixing tenant + non-tenant tables, sub-queries.
- **F88.** In the dispatcher catch, write a deny audit before rethrowing `PermissionDeniedError`. Decide: forbid `PermissionDeniedError` from handlers (sub-block ACL moves to a pre-handler gate extension) OR add a first-class post-parse deny channel. Choice: post-parse deny channel, since sub-block ACLs need ctx-aware information the gate doesn't have.
- **F89.** Either strike all arch-lint references from prose until the package lands, or create a minimum-viable `@editorzero/arch-lint` with the one rule most load-bearing (`no-raw-kysely-outside-db`). Downgrade coherence-script comments from "fails the commit on X" to "will fail the commit on X when stub lifts" for the two stubs that haven't activated.
- **F90.** Widen `AuditWriteInput` with `category: CapabilityCategory` and `collapsed_count: number` (default 1). Swap FNV for sha256 via `crypto.createHash`. Ensure every dispatcher code path sets both new fields.
- **F91.** At `createSqliteDriver`, after opening the `better-sqlite3` database, run: `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;` (values per ADR 0007). Note which are per-connection vs per-database.
- **F92.** In dispatcher's context build, wrap `extras.transact` with a closure that throws `TransactCalledTwiceError` on second call. Test: handler that calls `ctx.transact` twice → dispatcher catches, writes error audit.
- **F93.** Replace the `1000` literal in `packages/capabilities/src/doc/list.ts` + its unit test with `AUDIT_READ_COLLAPSE_WINDOW_MS` from `@editorzero/constants`.

## Defend-these notes (UNUSUAL-GOOD follow-up)

Copy the four UNUSUAL-GOOD patterns into `AGENTS.md` § Defend these (new section) so future refactors encounter a friction they have to explicitly argue past. Do this in the closing commit for this disposition.

## Post-fix verification checklist

Before marking this disposition closed:

- [ ] Plant a deliberate `AuditEffect.kind` typo in a test file. Commit fails at the pre-commit `types` hook. Revert.
- [ ] Construct a `DispatchInvocation` with `principal.workspace_id = A` and `access.workspace_id = B`. Dispatch rejects before gate runs. (Or: type system makes this impossible to construct.)
- [ ] Write a query `db.selectFrom("docs as d").selectAll().execute()` and `db.selectFrom("docs").innerJoin("docs as d", …)`. Both return zero rows across workspace boundaries and emit valid SQL.
- [ ] Handler that calls `ctx.transact` twice triggers the runtime backstop.
- [ ] Handler that throws `PermissionDeniedError` produces exactly one `outcome = "deny"` audit row.
- [ ] Driver-level SQLite test confirms `PRAGMA journal_mode` returns `wal` after open.
- [ ] `AuditWriteInput` shape matches `audit_events` columns enumerated in architecture.md §3.11 field-for-field.
- [ ] `pnpm coherence` passes; prose around the coherence checks + arch-lint doesn't overclaim.
- [ ] `pnpm lint && pnpm -r build && pnpm -r typecheck && pnpm --filter @editorzero/dispatcher --filter @editorzero/capabilities --filter @editorzero/db test` all green.

## Should we run a pass-5?

Decide after this disposition closes. If the fix for F85 surfaces latent type errors we'd otherwise have shipped, that's a signal this pass earned its keep but a pass-5 at the same layer would rediscover the same class. If the fixes are tidy and nothing else falls out, the next pass is at the next natural phase boundary (end of Phase 3).
