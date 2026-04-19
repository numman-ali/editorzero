# ADR 0023 — Postgres driver substrate: `pg` + testcontainers + dual-backend conformance

**Status:** Proposed
**Date:** 2026-04-19
**Deciders:** @numman

## Context

ADR 0007 committed to a dual SQLite + Postgres storage strategy and a conformance test suite that runs identical assertions against both drivers. As of Phase 3.7 the SQLite driver (`packages/db/src/drivers/sqlite.ts`) is landed and the schema is dialect-portable by design (TEXT-stored JSON, `Uint8Array` BLOBs, epoch-ms numeric timestamps, composite FKs). The Postgres driver does not yet exist; the conformance harness therefore cannot fulfil its contract. Appendix C item 4 ("SQLite + Postgres conformance runners both green on the trivial slice") sits OPEN against the current tree.

The decisions that must land now — before a PG driver file can be written coherently — are the connection lib, the test substrate, the DDL split across dialects, the cross-dialect shape of `withSystemTx`, and where per-connection concerns live. The picks below incorporate a Codex peer review on an earlier draft; places where the review reversed or nuanced the initial pick are called out inline.

## Options considered

### Connection library

- **`pg` (node-postgres)** — canonical Kysely substrate; Kysely's core `PostgresDialect` is built on it. Latest stable `pg@8.20.0` (Apr 2026), no open CVEs against 8.x, steady 6-month cadence. Pool + controlled-tx behaviour is well-understood. Blessed path.
- **`postgres.js` via `kysely-postgres-js`** — first-party Kysely adapter exists; `postgres.js` ergonomics are nicer but controlled transactions route through a per-tx pool of `max=1`, different contention posture vs. `pg`. Off-piste for a v1 driver.

### Test substrate

- **`@testcontainers/postgresql` module** — dedicated module, built-in readiness (port + healthcheck) + connection URI accessor. Accepts a pinned image string/digest. Avoids the stock-module log-line "ready twice" gotcha (testcontainers-node issue #997) entirely.
- **Generic testcontainers + log-line wait** — works, but handrolled readiness logic against Postgres's "database system is ready to accept connections" log (emitted twice during init) needs a 2nd-occurrence wait strategy. Strictly worse than the dedicated module.
- **External-URL-only** — assumes the dev / CI has a Postgres running. Simpler code path but worse dev ergonomics; no single-command test story.
- **External-URL-as-override on top of testcontainers** — testcontainers by default, escape hatch for CI + long-lived dev Postgres. Chosen shape below.

### Type mapping across dialects

- **Everything numeric → `BIGINT` on PG** — naïve but wrong. `pg` returns `int8` as **string** by default; every existing `z.number()` contract (timestamps, `seq`, `next_seq`, `visibility_version`, `collapsed_count`, `duration_ms`) would silently drift to string-typed reads. Ship-breaker.
- **`INTEGER` everywhere on PG** — preserves Number-typed reads but breaks epoch-ms contract: `created_at` and friends already exceed 2^31 (Apr 2026 ≈ 1.76e12), so `INTEGER` (32-bit on PG) would overflow today.
- **Selective `BIGINT` (timestamps + `seq`/`next_seq`); `INTEGER` for bounded counters; pool-scoped `int8` → Number parser** — chosen. Codex caught the `int8` parser issue on the earlier draft; landing it at pool-construction time via the `pg.Pool({ types })` option avoids the global `pg.types.setTypeParser` footgun.

## Decision

### 1. Connection library: `pg` ^8.20

Use Kysely's built-in `PostgresDialect` composed over `pg.Pool`. No wrapping dialect subclass on the PG side (unlike `EditorZeroSqliteDialect`) — the contracts `withSystemTx` signals are natively supported by the stock `PostgresAdapter` (see §3 below). Pool config lives on `PostgresDriverOptions`:

```ts
interface PostgresDriverOptions {
  readonly connectionString: string;
  readonly poolMax?: number;         // default 10 (matches pg.Pool default)
  readonly idleTimeoutMs?: number;   // default 30_000
}
```

### 2. Test substrate: `@testcontainers/postgresql` + pinned image + optional URL override

Default path — spin a `@testcontainers/postgresql` container per test run, pinned to a stable image (`postgres:17.4-bookworm` with a digest lock) and using the module's native readiness strategy. Return the URI + driver to the test.

Override path — if `EDITORZERO_TEST_POSTGRES_URL` is set, skip container creation and point the driver at that URL. The override must apply per-run DB or schema isolation (test harness creates a uniquely-named schema and sets `search_path` on the pool) so a reused local Postgres cannot leak state between runs. Codex flagged the earlier "generic `EDITORZERO_POSTGRES_URL`" as a footgun — the explicit `_TEST_` prefix + isolation discipline is the fix.

Both paths feed the same `createPostgresDriver({ connectionString, ...commonPoolConfig })` factory. No behavioural forks in driver code — the difference is purely URI acquisition + test-harness cleanup.

### 3. `withSystemTx` cross-dialect semantics

The `setIsolationLevel("serializable")` signal that `withSystemTx` already emits is honoured by both backends, with **different semantics**:

- **SQLite** — `EditorZeroSqliteDriver.beginTransaction` intercepts and emits `BEGIN IMMEDIATE`. Writer contention surfaces at tx-start (retryable, bounded by `busy_timeout`).
- **Postgres** — Kysely's `PostgresAdapter` natively emits `START TRANSACTION ISOLATION LEVEL SERIALIZABLE`. Contention can surface *mid-tx* as `40001 serialization_failure` or `40P01 deadlock_detected`. These are retryable conflicts from the caller's perspective — **not** a silent downgrade to READ COMMITTED.

**Explicitly not in scope of this ADR:** bounded retry inside `withSystemTx`. That's its own correctness slice (idempotency of `fn`, gapless `seq` allocation under retry, audit-row de-duplication). Deferred to a follow-up ADR once real workload drives the requirement. Today capability handlers see `40001`/`40P01` as a thrown error; callers handle it (most don't need to — seq allocation uses `SELECT … FOR UPDATE` which serialises cleanly).

Landing today: a conformance smoke asserting `SELECT current_setting('transaction_isolation')` inside `withSystemTx` returns `serializable` on PG, and the SQLite equivalent via PRAGMA. Proves the signal routes correctly end-to-end on both backends.

### 4. DDL split: `postgres-ddl.ts` parallel to `sqlite-ddl.ts`

New `packages/db/src/drivers/postgres-ddl.ts` mirrors the SQLite DDL table-for-table. Type mappings:

| SQLite | Postgres | Applies to |
|---|---|---|
| `TEXT` | `TEXT` | IDs, enums, slugs, hashes |
| `BLOB` | `BYTEA` | `doc_snapshots.state`, `doc_updates.update_blob` |
| `INTEGER` (epoch-ms or counter) | `BIGINT` | `*_at` timestamps, `seq`, `next_seq`, `delete_after` |
| `INTEGER` (bounded counter) | `INTEGER` | `visibility_version`, `collapsed_count`, `duration_ms` |
| `INTEGER` (boolean-ish default) | `INTEGER` | defaults unchanged |

All constraints translate 1:1 (`PRIMARY KEY`, composite `UNIQUE`, `FOREIGN KEY (…) REFERENCES … ON DELETE CASCADE`). Exports land as per-dialect names to keep the import site explicit: `SQLITE_FULL_DDL`, `POSTGRES_FULL_DDL` (was `FULL_DDL` — renamed). Existing `FULL_DDL` callers in the tree migrate to `SQLITE_FULL_DDL`.

### 5. Per-pool `types` + `onConnect` — contract layer for per-connection invariants

Per-pool `types` option parses PG OID 20 (`int8`) with a safe-integer guard:

```ts
const types = {
  getTypeParser: (oid: number) => {
    if (oid === 20 /* int8 */) {
      return (raw: string) => {
        const n = Number(raw);
        if (!Number.isSafeInteger(n)) {
          throw new Error(`int8 value ${raw} exceeds Number.MAX_SAFE_INTEGER`);
        }
        return n;
      };
    }
    return pg.types.getTypeParser(oid);
  },
};
```

This keeps `BIGINT` → `number` conversion **scoped to the editorzero pool** rather than globally via `pg.types.setTypeParser` (which would leak into any other `pg.Pool` a host process constructs). Safe-integer guard fails loud if epoch-ms overflows `Number.MAX_SAFE_INTEGER` — a sensor for future date-arithmetic regressions.

`onConnect` hook (pg.Pool's `connect` event) pins per-connection invariants:

- Today: `search_path` (when env-var override path uses a per-run schema).
- Later: `application_name` for pg-level observability (`pg_stat_activity.application_name`).

### 6. Binary data: no transformer, one round-trip test

`pg.Pool.query` accepts any `ArrayBufferView` outbound (prepareValue wraps `Uint8Array` in `Buffer`) and returns `BYTEA` columns as `Buffer` (which is itself a `Uint8Array` by JS contract). No dialect-specific binary adapter needed. The conformance harness lands one non-trivial Uint8Array round-trip (`doc_updates.update_blob` with a real Yjs-encoded delta) as the empirical pin.

### 7. Non-scope: Atlas migrations + PG analyzer alternatives

ADR 0007 already commits to Atlas CE + covers the paywalled PG analyzer gaps through conformance tests. No migrations exist in the tree today (the schema is hand-written DDL under `sqlite-ddl.ts`), so the migration-lint question is genuinely deferred until an Atlas pipeline lands. A follow-up ADR will pick between **Squawk** (pre-commit fast lane) and **Eugene** (nightly CI against a real PG, records actual locks) when we have real migrations to run them against. Cross-reference only; this ADR is scoped to the driver + harness.

## Consequences

**Easier:**
- Conformance harness can land with a real second backend — Appendix C item 4 becomes CLOSED-for-trivial-slice instead of unsatisfiable.
- `pnpm test` in `packages/db` spins a container, runs cross-backend assertions, tears down. No developer precondition beyond Docker (already soft-dep for `docker compose` smoke).
- Integration pre-push lane un-skips in `lefthook.yml` once `packages/db/test/integration/` exists.
- The `int8` parser landed at pool scope means future capabilities handling timestamps or `seq` read `number` uniformly across backends — no per-caller coercion.

**Harder:**
- Two DDL files to keep in sync until Atlas codegen takes over. Coherence script will need a pairwise-schema check (follow-up).
- Developers without Docker must either install it or set `EDITORZERO_TEST_POSTGRES_URL` against an external Postgres. Documented in `AGENTS.md` Gotchas.
- Semantic difference between SQLite `BEGIN IMMEDIATE` (contention at tx-start) and PG `SERIALIZABLE` (mid-tx abort as `40001`/`40P01`) is real. Until bounded retry lands (follow-up ADR), callers that want full portability under high contention must handle these as retryable themselves.

## Revisit triggers

- `pg` ships a 9.x major that changes pool / controlled-tx semantics; re-evaluate against `kysely-postgres-js` at that point.
- testcontainers-node ships a ryuk-free or significantly lighter mode that makes the Docker dep redundant for the common dev case.
- A capability handler in the tree hits `40001 serialization_failure` under normal traffic — at that point bounded retry in `withSystemTx` is no longer deferrable.
- Atlas CE adds back the PG301–PG311 analyzers (Atlas Pro reversal), or one of Squawk/Eugene becomes the consensus pick for OSS PG migration lint.
- Postgres 18 releases and we pick an image bump; ensure the `int8` parser is still valid (unlikely to change but worth a verification pass).
