# ADR 0007 — Database strategy: dual SQLite + Postgres with Kysely + Atlas

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Meta-prompt mandates dual backend: SQLite for single-node self-hosts (no extra process); Postgres for scale and HA. Schema covers polymorphic principals (users + agents, ADR 0016), workspaces, docs, blocks, versions, audit log, comments, attachments metadata, CRDT state (snapshots + updates log), job queue (ADR 0014), search indexes.

The red-team (#5) flagged that dual-dialect support doubles the correctness surface. Disposition: do not drop SQLite (it's a requirement), but declare a ceiling and enforce behavior parity via conformance tests.

## Options considered
- **Drizzle ORM** — dialect-aware; separate schemas per dialect; CVE-2026-39356 plus `drizzle-kit` esbuild advisories.
- **Prisma 7** — faster post-Rust-removal but SQLite remains "partial parity" for ops we use (`jsonb`, FTS, arrays).
- **Kysely + Atlas** — Kysely is a dialect-aware query builder with full type inference; Atlas is declarative migrations with dual-dialect support and CI integrity checks.
- **Raw SQL + dbmate/goose** — gives up type inference.

## Decision
**Kysely for queries, Atlas for migrations.** Divergence is expressed at the SQL layer, not hidden.

### SQLite-mode declared ceiling (red-team #5)

SQLite mode targets single-node self-hosts. Declared envelope:
- ≤ 50 concurrent authenticated users
- ≤ 10 concurrent editors per doc
- ≤ 1 million blocks total across the instance
- ≤ 100 jobs/min sustained queue throughput (ADR 0014)
- ≤ 500 updates/sec sustained across all docs (with ADR 0003 per-session caps)

Exceeding the envelope is not a crash — it's a performance cliff — but we do not warrant behavior beyond it. Installer prints this on first run and in `/admin/health`.

### Conformance test suite

Every capability (ADR 0015) gets a parameterized test that runs against both SQLite and Postgres with identical assertions. CI fails if the two drivers diverge on observable behavior for any in-envelope workload.

### CRDT state persistence

Snapshot + updates-log hybrid. Two tables:
```
doc_snapshots(id, doc_id, seq, state BLOB, created_at)
doc_updates  (id, doc_id, seq, update BLOB, created_at)
```

**Compaction spec (red-team #15):**
- **Trigger:** whichever comes first — 500 updates since last snapshot, 10 MB of updates since last snapshot, or 30 minutes elapsed. Trigger is per-doc and idempotent.
- **Atomicity:** compaction is a single DB transaction: `INSERT new snapshot → UPDATE doc_snapshots.seq to (max update seq applied) → UPDATE old updates with tombstone.delete_after = now() + 24h`. No updates are deleted in the same transaction; a reaper reclaims tombstoned rows after 24h.
- **Reader semantics:** document load uses the most-recent snapshot WHERE `seq <= target` plus `doc_updates` WHERE `doc_id = ?` AND `seq > snapshot.seq` AND `tombstone.delete_after IS NULL OR tombstone.delete_after > now()`. Concurrent compaction never invalidates an in-flight read.
- **Failure recovery:** if compaction is killed mid-transaction, the transaction never commits and the old snapshot + updates remain untouched. No half-compaction states.
- **GC:** two-phase with 24h grace; tombstoned updates are recoverable until the reaper runs. Monitored via OTel (ADR 0019).

### SQLite runtime pragmas

`journal_mode=WAL`, `synchronous=NORMAL`, `wal_autocheckpoint=1000`, `journal_size_limit=67108864`, `foreign_keys=ON`, `busy_timeout=5000`. Batch updates in explicit transactions.

### libSQL / Turso

Supported as opt-in SQLite-mode replacement for users who want embedded replicas or multi-region reads. **Not default** — default SQLite keeps the stock-system-SQLite promise.

## Consequences
- No ORM papering over dialect differences; divergence is named and tested.
- SQLite-mode ceiling is explicit and installer-visible.
- Compaction is specified, atomic, and recoverable; the "lose data when OOM killer hits compaction" failure mode is closed.
- Conformance test suite is part of the Phase 3 harness — every capability runs on both backends every CI run.

## Revisit triggers
- Kysely maintainership slows or a type-inference regression lands.
- SQLite WAL growth or write contention exceeds what pragmas + compaction hold, even within envelope.
- A production outage traced to a dialect-divergence bug the conformance suite missed → expand the suite.
- libSQL becomes compelling enough to promote to default.
