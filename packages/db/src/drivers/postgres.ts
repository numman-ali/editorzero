/**
 * Postgres driver for `@editorzero/db` (ADR 0023).
 *
 * Wraps `pg.Pool` behind Kysely's stock `PostgresDialect`. Matches the
 * SQLite driver's public shape (`scoped` / `system` / `withSystemTx` /
 * `close` / `exec`) with two dialect-specific additions:
 *
 *  - `setting(name)` is the PG analogue of SQLite's `pragma(name)` —
 *    reads a GUC via `current_setting()`. The two are NOT interchangeable
 *    (SQLite pragmas are mostly compile-time engine knobs; PG GUCs are
 *    session-level runtime knobs), so the driver surfaces them under
 *    dialect-specific names rather than a shared getter that would
 *    pretend the concepts align.
 *  - `exec(sql)` returns `Promise<void>` here (pg is async-native)
 *    whereas the SQLite driver's `exec` is sync (better-sqlite3's
 *    `conn.exec` returns synchronously). Test fixtures and the
 *    conformance harness handle the shape divergence explicitly.
 *
 * **No wrapping dialect subclass** (unlike `EditorZeroSqliteDialect`).
 * The stock `PostgresAdapter` already emits:
 *
 *  - `START TRANSACTION ISOLATION LEVEL SERIALIZABLE` when Kysely's
 *    transaction receives `setIsolationLevel("serializable")` — the
 *    exact signal `withSystemTx` uses.
 *  - Savepoint SQL (`SAVEPOINT` / `ROLLBACK TO` / `RELEASE`) on the
 *    stock `Driver` without the passthrough-wrap `EditorZeroSqliteDriver`
 *    needs. PG's pg-pool driver implements these unconditionally.
 *
 * ADR 0023 §3 records that PG's `SERIALIZABLE` differs *semantically*
 * from SQLite's `BEGIN IMMEDIATE`: PG can abort mid-tx with 40001
 * (serialization_failure) or 40P01 (deadlock_detected) as retryable
 * conflicts. Bounded retry inside `withSystemTx` is deferred to a
 * follow-up ADR — callers today see those error codes thrown out of
 * `withSystemTx` and handle them explicitly.
 *
 * **Per-pool `types`** (ADR 0023 §5). OID 20 (`int8` / `BIGINT`) is
 * parsed to `number` with a safe-integer guard *at pool construction*,
 * avoiding `pg.types.setTypeParser(20, ...)` which would leak globally
 * into every `pg.Pool` a host process constructs. The guard fails loud
 * if an `int8` column ever exceeds `Number.MAX_SAFE_INTEGER` — a
 * sensor for future epoch-arithmetic regressions (epoch-ms will hit
 * that ceiling around year 287396, so this is about catching schema
 * drift or corruption, not date math).
 *
 * **`onConnect` hook**. `pool.on("connect", ...)` applies per-connection
 * invariants. Today that's `search_path` for the `EDITORZERO_TEST_
 * POSTGRES_URL` override path's per-run schema isolation (ADR 0023 §2);
 * later this is where `application_name` will pin for
 * `pg_stat_activity.application_name` observability.
 */

import type { WorkspaceId } from "@editorzero/ids";
import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";

import type { SystemDatabase } from "../schema";
import { createTenantScopedDb, type TenantScopedDb } from "../tenant";

export interface PostgresDriverOptions {
  /** libpq connection string (`postgres://user:pass@host:port/db`). */
  readonly connectionString: string;
  /** Pool max clients. Default 10 (matches pg's own default). */
  readonly poolMax?: number;
  /** Idle-connection timeout before pg reaps. Default 30_000ms. */
  readonly idleTimeoutMs?: number;
  /**
   * Per-connection `search_path` pin. Used by the test harness when the
   * `EDITORZERO_TEST_POSTGRES_URL` override path creates a per-run
   * schema to prevent state bleed against a reused local PG (ADR 0023
   * §2). When unset, the pool inherits the server default (typically
   * `"$user", public`).
   */
  readonly searchPath?: string;
}

export interface PostgresDriver {
  /** Workspace-scoped handle; every query auto-applies `workspace_id`. */
  scoped(workspace_id: WorkspaceId): TenantScopedDb;
  /**
   * Unscoped `Kysely<SystemDatabase>` — same escape-hatch role as the
   * SQLite driver's `system()`. Reserved for dispatcher / outbox-poller
   * / audit-writer; `no-raw-kysely-outside-db` keeps imports pinned.
   */
  system(): Kysely<SystemDatabase>;
  /**
   * Run `fn` inside a single SERIALIZABLE transaction against the
   * system DB. PG-side counterpart to SQLite's `withSystemTx`. Same
   * signal (`setIsolationLevel("serializable")`) drives both backends;
   * ADR 0023 §3 records the retry-semantic divergence between them.
   */
  withSystemTx<T>(fn: (tx: Transaction<SystemDatabase>) => Promise<T>): Promise<T>;
  /** Shut down Kysely + drain the connection pool. */
  close(): Promise<void>;
  /**
   * Raw async DDL / migration escape hatch. Same role as the SQLite
   * driver's `exec` but asynchronous (pg is async-native). Migration
   * runner + test setup only.
   */
  exec(sql: string): Promise<void>;
  /**
   * Session-level GUC getter via `current_setting(name, missing_ok=true)`.
   * Returns the setting as string or `null` if the GUC does not exist.
   * The PG analogue of SQLite's `pragma` — surfaced under a dialect-
   * specific name so callers do not pretend the two concepts align.
   */
  setting(name: string): Promise<string | null>;
}

/**
 * PG int8 OID. The GC-proof literal is preferable to importing
 * `pg.types.builtins.INT8` — keeps the driver's type-parser config
 * inspectable in one line.
 */
const INT8_OID = 20;

function buildTypes(): pg.CustomTypesConfig {
  return {
    getTypeParser: ((oid: number, format?: "text" | "binary") => {
      if (oid === INT8_OID) {
        return (raw: string) => {
          const n = Number(raw);
          if (!Number.isSafeInteger(n)) {
            throw new Error(
              `int8 value "${raw}" is outside Number.MAX_SAFE_INTEGER; ` +
                `the editorzero PG driver parses int8 as Number with a safe-integer guard (ADR 0023 §5).`,
            );
          }
          return n;
        };
      }
      return pg.types.getTypeParser(oid, format);
    }) as pg.CustomTypesConfig["getTypeParser"],
  };
}

function pgIdent(name: string): string {
  // PG identifier escape. Identifiers are double-quoted; embedded quotes
  // become `""`. Defence-in-depth only — `search_path` schema names
  // come from the test harness (which generates them), not user input.
  return `"${name.replace(/"/g, '""')}"`;
}

export function createPostgresDriver(options: PostgresDriverOptions): PostgresDriver {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    types: buildTypes(),
  });

  if (options.searchPath !== undefined) {
    const searchPath = options.searchPath;
    pool.on("connect", (client) => {
      // Fire-and-forget: if SET fails, the next query on this client
      // will surface the real error with its own context. Swallowing
      // here avoids a crash in the pool's connect-event chain.
      void client.query(`SET search_path TO ${pgIdent(searchPath)}`).catch(() => {
        // Intentional: see block comment above.
      });
    });
  }

  const dialect = new PostgresDialect({ pool });
  const base = new Kysely<SystemDatabase>({ dialect });

  return {
    scoped: (workspace_id) => createTenantScopedDb(base, workspace_id),
    system: () => base,
    withSystemTx: (fn) => base.transaction().setIsolationLevel("serializable").execute(fn),
    close: async () => {
      await base.destroy();
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    setting: async (name) => {
      const r = await pool.query<{ current_setting: string | null }>(
        "SELECT current_setting($1, true) AS current_setting",
        [name],
      );
      return r.rows[0]?.current_setting ?? null;
    },
  };
}
