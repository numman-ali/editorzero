# Continuation — rolling work state

What's happening now + what's next. `AGENTS.md` is the stable companion.

## Current phase

**Phase 3 — verification harness + first slice.** Phase 2 closed 2026-04-18 after three red-team passes (F1–F84). Architecture in `docs/architecture.md`. ADRs 0001–0022.

## Immediate focus

Three capabilities land end-to-end at the kernel layer: `doc.create`, `doc.get`, `doc.list`. Write-path single-tx atomicity is **closed for content mutations** via the P3.6 series — `HocuspocusSync` persists `doc_updates` inside the dispatcher's write-path tx; `BoundSyncService.rollback` evicts the resident Y.Doc on abort; `packages/dispatcher/prop/writepath-atomicity.test.ts` sweeps every in-tx query position across cold + warm paths (32 tests) asserting the five-row commit is all-or-none.

## What's next

**Phase 3 unblock — autonomous:**

- **BlockNoteEditor adapter-boundary smoke** — **no-WS half closed 2026-04-19** (`packages/sync/src/blocknote.integration.test.ts`; Appendix C item 11 → PARTIAL). WS-client concurrent-edit half remains Phase 4 (broadcast-buffering-until-commit; ADR 0018 § Out of scope).
- **Dual-backend conformance harness** — **closed 2026-04-19** (`packages/db/test/integration/`; Appendix C item 4 → CLOSED). Parametrised SQLite + Postgres conformance runs 14 tests (tenant-scoping + `withSystemTx` atomicity) and activates lefthook's pre-push `integration` lane. ADR 0023 codifies the Postgres substrate picks.
- **Metadata-only mutation atomicity** — the planned `metadata-only-set.integration.ts` closure artifact; prerequisite is a real runtime composition site for the dispatcher with `ctx.outbox(...)` un-stubbed (every current `createDispatcher(...)` call is a test fixture).

**Phase 3 surface adapters (ADR 0021 topology):**

- **Hono API trunk** — `packages/api-server` + `packages/api-client` with `hc<AppType>` typed RPC; server-side callers use `testClient(app)`.
- **CLI** — `apps/cli` via `citty` + `bun build --compile`; agent-mode governed by AXI, TTY mode by clig.dev. Agent-mode serializer (TOON vs JSON) deferred to an eval harness at CLI-slice time.
- **MCP** — `packages/mcp-server` via `@hono/mcp` + `@modelcontextprotocol/sdk` 1.x; Streamable-HTTP only.
- **Web UI** — `apps/app` + `apps/admin` (Next.js 16 App Router).

**Gated on @numman decision:** Phase-4 entry gate revision (Open Question 3). Appendix C's "all entries CLOSED" rule is unsatisfiable against the current tree; rule revision + dual-backend scope answer land at phase boundary. Current matrix: 2 CLOSED-for-content-mutations / 2 PARTIAL / 12 OPEN. Detail lives in `docs/architecture.md` § Appendix C.

## Open questions for @numman

1. **Commercial arm** — OSS-only or OSS + hosted? AGPL-3.0 + DCO doesn't pre-commit the answer. Doesn't block Phase 3.
2. **Agent offline-edit semantics** — do agents get offline/reconcile, or always-online? Default "always-online" stands unless challenged. Doesn't block Phase 3.
3. **Phase-4 entry gate** — revise Appendix C's "all entries CLOSED" rule; name an explicit minimum-CLOSED set and assign every other item to a named deferral bucket. Inputs to the revision: (a) ADR 0007 dual-backend scope (keep Postgres commitment, or SQLite-first with Postgres deferred), (b) pre-boundary polish lifts (BlockNoteEditor smoke, SQLite conformance harness above). **Blocks Phase-4 entry.**

## Recent history

- **2026-04-19** — ADR 0023 (Postgres driver substrate) + dual-backend conformance harness landed across 3 commits: ADR writeup (`fb7fe27`), Postgres driver + 9-test testcontainers unit harness (`8c52ee3`, `packages/db/src/drivers/postgres.ts` / `postgres-ddl.ts`), and the parametrised SQLite+Postgres conformance suite (`87e233b`, `packages/db/test/integration/` — 14 tests). Activates lefthook's pre-push `integration` lane. Codex adversarial review pre-coding drove three reversals (selective BIGINT/INTEGER split, per-pool `types` override, retry-semantic framing). Closes Appendix C item 4.
- **2026-04-19** — BlockNote adapter-boundary smoke landed (`packages/sync/src/blocknote.integration.test.ts`): closes the no-WS half of Appendix C item 11 (3 tests: smoke / projection / rollback). Empirical finding — server-side `BlockNoteEditor` mutation needs a DOM shim (`happy-dom` + `editor.mount`); without it the y-prosemirror plugin's writes never reach the fragment. AGENTS.md gotcha + ADR 0018 § Empirical verification updated.
- **2026-04-19** — Refactor pass: AGENTS.md (132 lines) + `docs/continuation.md` rewritten; `docs/cluster-check.md` deleted; per-commit Codex ceremony replaced with self-critique-at-meaningful-moments. CLAUDE.md added with private cmux notes for the Codex peer channel.
- **2026-04-19** — P3.7: Appendix C status sweep matrix published (diagnostic, not gate; surfaced Open Question 3 above).
- **2026-04-19** — P3.6 closes for content mutations: write-path-atomicity crash-fuzz property test; ADR 0018 § Empirical verification written up.
- **2026-04-18** — P3.6a–e: dispatcher write-path tx primitive → `HocuspocusSync` persists `doc_updates` in-tx → audit writer emits `outbox(audit.appended)` in same tx → `onLoadDocument` hydration + `BoundSyncService.rollback`.
- **2026-04-18** — Red-team pass #4 against landed code (F85–F97): `WorkspaceScopingPlugin` alias/join-aware, coverage floor 95/90, runtime `ctx.transact` at-most-once backstop.
- **2026-04-18** — P3.5: `doc.create` + `doc.get` + `doc.list` end-to-end through dispatcher → tenant-scoped DB → audit. ADRs 0021 (surface transport) + 0022 (agent editing) landed.
- **2026-04-18** — Phase 3 foundations landed: `constants`, `ids`, `scopes`, `audit`, `principal`, `capabilities`, `errors`, `dispatcher`, `db`, `sync`, `blocks`, `observability`, `config`.
- **2026-04-17** — Phase 2 closed after three red-team passes (F1–F84, cross-model on pass-3). Phase 1 ADRs 0001–0020.

## Resume protocol

1. `AGENTS.md` is auto-loaded.
2. Read this file for current focus + what's next.
3. `git log --oneline -20` for in-flight work.
4. Read only ADRs relevant to the immediate focus.
5. If an open question would block the next action, raise it; otherwise proceed.

## Update protocol

- At phase boundaries: update Current phase, Immediate focus, What's next, Recent history; commit.
- Mid-phase: one-line entries in Recent history. Don't paste commit bodies or review transcripts — those live in the commit itself.
- Roll entries older than ~7 off the bottom. `git log` carries the deeper trail.
