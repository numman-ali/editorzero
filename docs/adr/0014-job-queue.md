# ADR 0014 — Job queue: pg-boss on Postgres, custom in-DB on SQLite

**Status:** Accepted (post-red-team; updated 2026-04-17 to reflect pass-3 disposition)
**Date:** 2026-04-17
**Deciders:** @numman

> **Updated 2026-04-17 to reflect pass-3 disposition (F74).** Outbox-driven enqueue contract tightened: the poller claims `outbox.forwarded_at` and inserts into `pgboss.job` (or SQLite `jobs`) in **one DB transaction**. Any failure on the downstream insert → `ROLLBACK` undoes the claim, leaving the row for the next poll. "Mark forwarded then enqueue" is a forbidden ordering — an earlier phrasing in this ADR that suggested it has been corrected.

## Context
Phase 0 self-critique flagged the missing primitive: webhook delivery, notification fanout, embedding generation, search indexing, CRDT update-log compaction, import/export, email delivery. All need durability + retry + exponential backoff + dead-worker recovery. Queue must work in both SQLite-mode (default self-host, declared ceiling, ADR 0007) and Postgres-mode (scale).

Red-team (#14) flagged that a single custom queue across both dialects ships bugs — `SKIP LOCKED` vs SQLite serialization are different semantic universes. Disposition: split the implementation; use pg-boss where it's best.

## Options considered
- **BullMQ** (Redis-backed) — de facto in the JS ecosystem; adds Redis to the default deploy graph; rejected on that basis.
- **pg-boss** (Postgres-only) — mature, Postgres-native, battle-tested primitives (cron, priority, retry, dead-letter).
- **PGMQ** (Postgres extension) — newer; requires extension install; adds operator burden.
- **Custom in-DB queue** — works on SQLite; viable for low throughput; fragile at scale.
- **River** (Go) — wrong ecosystem.

## Decision

- **Postgres mode: pg-boss from day one.** All background work routed through pg-boss. Retry/backoff/priority/cron are first-class. Scale ceiling is Postgres, not our code.

- **SQLite mode: custom in-DB queue**, simple claim-by-update pattern on a single `jobs` table. **Declared ceiling: ≤ 100 jobs/min sustained** (part of the ADR 0007 envelope). Upgrade path: switch to Postgres.

### Shared `JobService` interface

```ts
interface JobService {
  enqueue(queue: string, payload: unknown, opts?: JobOpts): Promise<JobId>
  subscribe(queue: string, handler: JobHandler, opts?: SubOpts): Subscription
  getJob(id: JobId): Promise<Job | null>
  cancelJob(id: JobId): Promise<boolean>
}
```

Two drivers: `PgBossJobService` and `SqliteJobService`. Capabilities call through the interface; they do not know which driver is active. Conformance tests (ADR 0007) run the same job scenarios against both.

### SQLite driver spec

```
jobs(
  id              TEXT PRIMARY KEY,
  queue           TEXT NOT NULL,
  payload         BLOB,
  status          TEXT NOT NULL,        -- pending | running | completed | failed | cancelled
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  run_after       INTEGER NOT NULL,     -- unix epoch ms
  owner           TEXT,
  locked_at       INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)
```

Workers poll (`WHERE status='pending' AND run_after <= now()`), claim (`UPDATE ... SET owner = :worker, status = 'running', locked_at = now() WHERE id = :id AND status = 'pending' RETURNING *`), execute, ack. Exponential backoff on failure; `locked_at` reaper reclaims stuck rows after `lock_ttl` (default 60s).

### Postgres driver (pg-boss)

Thin adapter that maps `enqueue/subscribe/getJob/cancelJob` to `boss.send / boss.work / boss.getJobById / boss.cancel`. pg-boss features we rely on from day one: `singletonKey` (dedupe), `startAfter` (delay), `retryLimit` + `retryBackoff`, `archiveCompletedAfterSeconds`.

**Outbox-driven enqueue (HA-safe, single-tx; F74):** Every outbox row forwarded by the transactional-outbox poller (architecture.md §6.3) passes `singletonKey = outbox.id` on `boss.send`. The claim UPDATE on `outbox.forwarded_at` and the `INSERT INTO pgboss.job` commit in **one** DB transaction; if the insert fails, ROLLBACK undoes the claim, leaving the row available for the next poll. This makes the enqueue idempotent across concurrent pollers in HA mode (even if two app nodes' pollers claim the same row in a rebalance, only one pg-boss job lands) AND crash-safe (no claim is durable without its matching job). The SQLite driver applies the same single-tx discipline: the outbox row's `forwarded_at` UPDATE and the downstream `jobs` INSERT commit together in `BEGIN IMMEDIATE`.

### Observability
- Per-queue depth gauge (OTel, ADR 0019).
- Per-queue age histogram (oldest pending job).
- Per-job span (enqueue → claim → complete | fail).
- Ceiling breach alert (SQLite driver: `jobs/min > 100` sustained 5 min).

## Consequences
- Zero extra deps in SQLite mode.
- Postgres mode gets mature semantics from day one; priority queues, cron, dead-letter without us reinventing them.
- Drivers diverge semantically; conformance tests (ADR 0007) enforce identical observable behavior on in-envelope workloads.
- Two code paths to maintain; bounded and well-tested is better than one-path-with-semantic-surprises.

## Revisit triggers
- SQLite-mode deployments regularly hit the ceiling and operators ask for pg-boss-equivalent features without migrating to Postgres.
- pg-boss maintainership stalls; look at PGMQ or a lighter custom Postgres queue.
- A workload pattern emerges that neither driver handles (e.g., millisecond-latency RPC queue); pick a purpose-built tool.
