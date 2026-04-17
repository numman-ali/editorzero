# ADR 0007 — Database strategy: dual SQLite + Postgres, Kysely + Atlas CE

**Status:** Accepted (post-refresh)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

## Context
Meta-prompt mandates dual backend: SQLite for single-node self-hosts, Postgres for scale. Refresh reconsidered Drizzle vs Kysely and re-evaluated Atlas.

## Options considered (refresh)
- **Drizzle ORM** — CVE-2026-39356 was patched 0.45.2 / 1.0.0-beta.20 (April 7 2026). But `drizzle-kit` still ships vulnerable esbuild and deprecated `@esbuild-kit/esm-loader`; security issue #5290 open since Jan 2026 with no maintainer response. 1.0.0-beta.9 silently deprecated the `strict` flag so `drizzle-kit push` runs `DROP TABLE` without confirmation — a data-safety regression in an actively-iterated beta. Supply-chain posture is the blocker.
- **Kysely** — v0.28.16 (April 10 2025), cadence slowed to patch-level. MySQL backslash-escape fix in v0.28.14 (Postgres/SQLite unaffected). kysely-codegen v0.20 added `defineConfig` + `postprocess`. Single maintainer but small, finished-feeling surface.
- **Prisma 7** — still "partial parity" SQLite.

## Decision
**Kysely + Atlas Community Edition.** Schema divergences expressed at SQL; no ORM abstraction fighting dialect features.

### Atlas Community Edition note (refresh)
As of **Atlas v0.38 (Oct 2025), `atlas migrate lint` moved behind the Pro plan** ($9/dev/mo + $59/CI-project/mo). Code remains Apache-2.0 and buildable from source; Community Edition keeps basic analyzers but the deep Postgres rules (PG301–PG311) and PII/nested-tx/SQL-injection analyzers are paywalled.

**Our posture:** pin Atlas Community Edition (self-build from source if binary paywall triggers). Cover the missing PG lock/rewrite rules via explicit conformance tests (ADR 0007 §conformance below). Re-evaluate if Atlas CE drops an analyzer we actively depend on.

### Production scale target (set 2026-04-17)

- **Postgres mode is the production target:** 500–1,000 active users per instance as a floor; **design headroom extends to 10,000 users** per instance with Hocuspocus Redis fan-out (ADR 0006), pgvector HNSW at the ~1M embedding scale (ADR 0008), and pg-boss queue (ADR 0014). Beyond 10k, reconsider multi-region and sharding.
- **SQLite mode is for small-team pilots, dev environments, and home-lab installs** inside the declared envelope below. Operators hitting the envelope migrate to Postgres mode via a documented switch (export + reimport on first boot with `EDITORZERO_DB=postgres://…`). Postgres migration is not zero-downtime in v1; documented as such.

### SQLite-mode declared ceiling
- ≤ 50 concurrent authenticated users
- ≤ 10 concurrent editors per doc
- ≤ 1 million blocks total across the instance
- ≤ 100 jobs/min sustained queue throughput (ADR 0014)
- ≤ 500 updates/sec sustained across all docs (ADR 0003 per-session caps)

Installer prints both the production target and the SQLite envelope on first run. Admin UI (`/admin/health`) surfaces current vs. envelope utilization so operators know when to migrate.

### Conformance test suite
Every capability (ADR 0015) gets a parameterized test running against both SQLite and Postgres with identical assertions. CI fails if the two drivers diverge on observable behavior for any in-envelope workload.

Additionally, the conformance suite covers the Postgres-specific safety analyzers that Atlas CE no longer ships: destructive-change in migrations (DROP COLUMN / ALTER COLUMN TYPE), long-running index creation without `CONCURRENTLY`, `SELECT ... FOR UPDATE` in migrations, and PII-shaped column renames.

### CRDT state persistence (unchanged from v1)
Snapshot + updates-log hybrid:
```
doc_snapshots(id, doc_id, seq, state BLOB, created_at)
doc_updates  (id, doc_id, seq, update BLOB, created_at)
```

**Compaction spec** (same as v1):
- **Trigger:** 500 updates OR 10 MB OR 30 minutes since last snapshot, per doc.
- **Atomicity:** single DB transaction — INSERT snapshot + UPDATE old-updates tombstone.delete_after in one tx. Old updates not dropped in the same tx; a reaper reclaims tombstoned rows after the retention floor (below).
- **Reader semantics:** latest snapshot WHERE `seq <= target` plus `doc_updates` WHERE `seq > snapshot.seq` AND tombstone-valid. Concurrent compaction never invalidates in-flight reads.
- **Failure recovery:** killed compaction = transaction never commits; old snapshot + updates remain untouched.
- **GC retention floor:** tombstoned `doc_updates` rows are retained for **max(72h, RPO window)** before the reaper drops them. 72h is the architecture §18.1 invariant — it guarantees a backup + PITR round-trip completes before any CRDT update vanishes. Operators running Postgres with >72h WAL archives should raise the floor accordingly.

### SQLite runtime pragmas
`journal_mode=WAL`, `synchronous=NORMAL`, `wal_autocheckpoint=1000`, `journal_size_limit=67108864`, `foreign_keys=ON`, `busy_timeout=5000`.

### libSQL / Turso
Supported as opt-in SQLite-mode replacement; not default.

## Consequences
- No ORM papering over dialect differences.
- Atlas CE covers most lint needs; our conformance suite covers the paywalled Pro analyzers.
- Kysely's single-maintainer surface is small and stable; bus-factor risk mitigated by the library being "finished."
- Drizzle's supply-chain posture made the switch unwise despite the validator ergonomics win.
- The tenant-aware Kysely wrapper (ADR 0015 Layer 2) is the load-bearing construct; switching to Drizzle would require a full rewrite since Drizzle's relational query builder v2 does not expose a compile-time hook equivalent to Kysely's `Expression<T>`.

## Revisit triggers
- Drizzle v1.0 stable ships with a hardened `drizzle-kit` supply chain and the destructive-safety prompt restored.
- Atlas CE drops a PG analyzer we depend on, or Atlas Pro becomes cheap enough to stop mattering.
- Kysely's lone maintainer disengages AND a library-level regression lands.
- libSQL becomes compelling enough to promote to default (embedded replicas justify the fork).
