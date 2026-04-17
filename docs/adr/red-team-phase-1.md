# Red-team report — Phase 1 ADR pass

**Date:** 2026-04-17
**Reviewer:** independent red-team subagent
**Scope:** tentative ADRs 0001–0014 before acceptance

The red-team returned 25 findings. This document logs each, its severity, the disposition, and the ADR(s) that address it. Findings marked **ACCEPTED** changed the design; **REBUTTED** were considered and rejected with reasoning; **DEFERRED** are acknowledged but not Phase-1 work.

| # | Severity | Finding (short) | Disposition | Lands in |
|---|---|---|---|---|
| 1 | BLOCKER | Bun 1.2 correctness gaps + enterprise LTS friction | ACCEPTED — switch to Node 22 LTS | ADR 0002 |
| 2 | BLOCKER | TanStack Start is not Phase-1-safe | ACCEPTED — Next.js 15 App Router | ADR 0005 |
| 3 | MAJOR | Three frontend frameworks is one too many | ACCEPTED — drop Astro; Next.js 15 only | ADR 0005 |
| 4 | MAJOR | y-sweet durability boundary unclear | ACCEPTED — unified via Hocuspocus embedded; see finding 21 | ADR 0006, ADR 0018 |
| 5 | MAJOR | Dual SQLite + Postgres doubles correctness surface | PARTIALLY ACCEPTED — declare SQLite-mode ceiling and conformance suite, do not drop SQLite (meta-prompt requires dual) | ADR 0007 |
| 6 | MAJOR | CRDT payload abuse has no declared ceiling | ACCEPTED — per-update byte cap, per-session rate cap, per-doc total-state cap, server-side validation | ADR 0003 |
| 7 | MAJOR | Markdown-AST + Yjs coupling needs property tests | ACCEPTED — randomized edit-sequence fixed-point harness in Phase 3 | ADR 0013 |
| 8 | MAJOR | Four-surface parity needs a named contract | ACCEPTED — single `capabilities/*.ts` registry as source of truth; codegen adapters; contract tests assert build-time and runtime parity | ADR 0009, ADR 0015 |
| 9 | MAJOR | Capability checks "centralized" is underspecified | ACCEPTED — enforcement at capability-invocation boundary; Postgres RLS as second line; un-tenanted queries forbidden | ADR 0015 |
| 10 | MAJOR | Agent principal model asserted, not designed | ACCEPTED — dedicated Principal model ADR with ActingAs, scopes, per-agent rate limits, revocation cascade | ADR 0016 |
| 11 | MAJOR | MCP audit-log flooding is a trivial DoS | ACCEPTED — per-principal audit rate limit, identical-sequential collapse, circuit breaker that suspends agent rather than dropping rows | ADR 0009, ADR 0016 |
| 12 | MAJOR | Caddy on-demand TLS = tenant enumeration + cert exhaustion | ACCEPTED — `ask` endpoint allow-lists from `custom_domains` table; per-tenant issuance cap; in-memory cert cache | ADR 0011 |
| 13 | MAJOR | Multi-tenant escape surface larger than SSO | ACCEPTED — merged with finding 9; RLS in Postgres, guarded query wrapper in SQLite | ADR 0015 |
| 14 | MAJOR | Custom in-DB queue ships bugs on both dialects | PARTIALLY ACCEPTED — pg-boss for Postgres from day one; SQLite keeps custom queue with declared ≤100 jobs/min ceiling | ADR 0014 |
| 15 | MAJOR | Snapshot/updates compaction hand-wavy | ACCEPTED — spec trigger, atomicity, reader semantics, two-phase GC | ADR 0007 |
| 16 | MAJOR | Soft-delete recoverability not scoped | ACCEPTED — dedicated ADR with window, cascade rules, inverse-restore property test | ADR 0017 |
| 17 | MAJOR | RRF k=60 + no eval harness = relevance cliff | ACCEPTED — search eval harness (judged set, nDCG@10) as Phase 3 deliverable | ADR 0008 |
| 18 | NOTE | bge-small cold-start and memory floor | ACCEPTED — lazy-load on first embedding request; document memory floors | ADR 0008 |
| 19 | MAJOR | AGPL + CLA is a contributor-trust smell | ACCEPTED — switch to DCO (Linux kernel model); do not pre-reserve relicensing rights | ADR 0001 |
| 20 | MAJOR | Single-binary deploy aspirational with native deps | ACCEPTED — drop single-binary stretch; docker-compose is the deploy, full stop | ADR 0012 |
| 21 | MAJOR | Dual-surface write races not addressed | ACCEPTED — all mutations (API/CLI/MCP/UI) flow through the CRDT via a single write path; Hocuspocus embedded makes this the simplest design | ADR 0018 |
| 22 | MAJOR | WCAG 2.1 AA needs CI tooling | ACCEPTED — `@axe-core/playwright` in E2E; manual screen-reader pass per release; public VPAT | AGENTS.md, Phase 3 harness |
| 23 | NOTE | Streamable HTTP idle/reconnect story | ACCEPTED — server keepalive, resume token, in-flight tool call resumption | ADR 0009 |
| 24 | MAJOR | DCR cleanup + per-tenant audience | ACCEPTED — DCR client TTL, cleanup policy, per-tenant canonical URL + audience | ADR 0009 |
| 25 | MAJOR | No stated observability story | ACCEPTED — OpenTelemetry SDK + `/metrics` + minimal admin dashboard | ADR 0019 |

## Summary of design changes

- **Runtime** changed from Bun to Node 22 LTS.
- **Frontend** simplified to Next.js 15 only (no TanStack Start, no Astro).
- **Real-time transport** changed from y-sweet sidecar to Hocuspocus embedded in the app process — resolving unified-write-path and durability-boundary concerns by construction.
- **License** governance changed from CLA to DCO.
- **Job queue** split: pg-boss on Postgres, custom-in-DB only on SQLite with declared ceiling.
- **Deploy** dropped single-binary stretch; docker-compose is the promise.
- **Five new ADRs** formalize previously-assumed subsystems: permission enforcement (0015), principal model (0016), soft-delete recovery (0017), unified write path (0018), observability (0019).

Nothing was rebutted. Finding 5 was partially accepted on the grounds that the meta-prompt mandates dual-backend support; the right response is conformance tests and a declared ceiling, not dropping SQLite.
