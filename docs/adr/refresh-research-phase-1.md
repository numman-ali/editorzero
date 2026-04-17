# Refresh-research report — Phase 1 v2

**Date:** 2026-04-17
**Context:** The Phase 1 v1 ADRs passed a red-team review (see `red-team-phase-1.md`) and were committed. The user (@numman) then flagged two concerns: (a) the "Markdown-in-a-versioned-folder" pointer in the original brief was a naive user pointer, and (b) several of the library versions I cited were stale. Spawned seven Opus sub-agents for a refreshed research pass.

## Research agents fanned out

| # | Topic | Finding |
|---|---|---|
| 1 | Bun 1.3+ server runtime re-eval | Stay on Node 22 LTS; use `bun build --compile` for CLI distribution + as monorepo test runner |
| 2 | Next.js 16 refresh | Stay on the plan; update v1's Next 15 → Next 16.2; note `proxy.ts` Node-only, `"use cache"`, Cache Components, React Compiler 1.0 stable opt-in, Turbopack default |
| 3 | Better Auth deep dive (MCP + agent auth) | **Big consolidation win.** Adopt `@better-auth/oauth-provider`, `@better-auth/mcp`, `@better-auth/api-key`, `@better-auth/agent-auth`. Shrinks ADR 0010 ~60% and deletes custom agent-credential work from ADR 0016. Pin >= 1.6.5 for security |
| 4 | BlockNote vs Milkdown rematch under relaxed constraint | **Switch to BlockNote.** Milkdown's defining property (Markdown-as-source-of-truth) stops doing work under ADR 0013 v2; block-first model + native IDs + `ServerBlockNoteEditor` + team maintainership + La Suite Docs at scale + FOSDEM 2026 with Kevin Jahns all favor BlockNote |
| 5 | Drizzle vs Kysely refresh | **Stay on Kysely + Atlas CE.** Drizzle CVE patched but supply-chain concerns (`drizzle-kit` esbuild, unreviewed security issues, silent `strict` flag removal) block the switch. Note Atlas `migrate lint` is Pro-only as of v0.38; pin CE + cover gaps in the conformance suite |
| 6 | CRDT-as-source-of-truth patterns | Validates the ADR 0013 v2 direction. BlockSuite / Affine already ship Transformer (lossless) vs Adapter (declared-lossy) split; Outline at scale with Yjs-as-truth; Logseq cautionary tale; no public RFC formalizes the three-tier fidelity contract — we're publishing it |
| 7 | Git-mirror export pattern | v1 architecture: `simple-git`, 2-min debounce + 60s push batch, author/committer split, skip binaries, push to dedicated branch with `--force-with-lease`, GitHub App > SSH > PAT auth. Ship S3-versioning archive as a secondary sink alongside |
| 8 | Misc dependency refresh | sqlite-vec ANN is alpha → downgrade SQLite-mode vector search ambition to brute-force primary; pgvector 0.8.2 patches CVE-2026-3172 (urgent pin); MCP SDK v2 is alpha → pin 1.x stable; Node 22 EOL corrected to Apr 30 **2027**; Hocuspocus 3.4.x `onStoreDocument` now non-concurrent; pnpm v11 supply-chain defaults |

## ADRs revised in v2

| ADR | Change |
|---|---|
| 0001 License | No change (AGPL-3.0 + DCO) |
| 0002 Backend runtime | Stays Node 22 LTS; add Bun-for-CLI section; correct EOL date to Apr 30 2027 |
| 0003 CRDT library | Add Hocuspocus 3.4.x behavior notes |
| 0004 Rich-text editor | **Switch Milkdown → BlockNote** |
| 0005 UI framework | Update Next 15 → Next 16.2; note `proxy.ts`, `"use cache"`, Cache Components, React Compiler 1.0 |
| 0006 Real-time transport | Hocuspocus 3.4.x behavior (`onStoreDocument` non-concurrent, `beforeSync` non-awaited) |
| 0007 Database | Atlas `migrate lint` Pro-only — pin CE, cover analyzers in conformance suite |
| 0008 Search | sqlite-vec ANN alpha (brute-force primary); pgvector CVE-2026-3172 pin; memory floors + lazy load documented |
| 0009 MCP SDK / capability | Pin MCP SDK 1.x stable (v2 alpha); consume Better Auth MCP middleware; DCR cleanup + per-tenant audience (DIY) |
| 0010 SSO (now Auth spine) | **Big expansion + shrink:** consume Better Auth core + sso + oauth-provider + mcp + api-key + agent-auth plugins |
| 0011 Custom domains + TLS | No change |
| 0012 Deploy artifact | Add Bun-compiled CLI as secondary cross-platform binary distribution |
| 0013 Block model | **Big rewrite:** CRDT-as-source-of-truth with per-block-type fidelity contracts (lossless / directive / opaque) |
| 0014 Job queue | No change |
| 0015 Permission enforcement | No change |
| 0016 Principal model | **Shrink:** delegate credential lifecycle to Better Auth plugins; keep principal spine + audit + Hocuspocus revocation cascade + per-tenant audience |
| 0017 Soft-delete recovery | No change |
| 0018 Unified write path | Concrete synthetic-client via BlockNote's `ServerBlockNoteEditor.transact()` |
| 0019 Observability | No change |
| **0020 Git-mirror export** | **New ADR.** Opt-in one-way mirror with S3-versioning as secondary archive sink |

## What didn't change (after a two-round pass)
- AGPL-3.0 + DCO.
- Yjs + Hocuspocus embedded + unified write path through the CRDT.
- Four-surface parity via single capability registry.
- Dual SQLite + Postgres with declared SQLite-mode ceiling + conformance test suite.
- Three-layer permission enforcement (capability-dispatch + tenant-aware query wrapper + Postgres RLS).
- Agents-as-first-class principals with distinct rate limits / audit / revocation.
- Soft-delete recovery + inverse-restore property test.
- OpenTelemetry + Prometheus + admin dashboard.

These load-bearing choices were invariant under both the red-team pass and the refresh.

## Remaining open questions (carried into Phase 2)
- Scale target (10 vs 10k users per instance) — from brief.md, still open.
- Sub-block ACLs — still open.
- Agent offline-edit semantics — default "agents always online" stands unless challenged.
- Commercial arm (OSS-only or OSS + hosted) — license decision doesn't depend on this; other decisions might.
