/**
 * SQLite driver for `@editorzero/db` (ADR 0007 SQLite mode).
 *
 * Wraps `better-sqlite3` behind a Kysely `SqliteDialect`. The public
 * surface is intentionally narrow: callers ask for a per-workspace
 * handle via `scoped(workspace_id)` and never hold the unscoped
 * `Kysely<Database>`. `exec` is the opt-in migration / test escape
 * hatch; its call-site restriction is enforced by the
 * `no-raw-kysely-outside-db` coherence check today (future:
 * `@editorzero/arch-lint` — see architecture.md §8.1a / §17).
 *
 * Why `better-sqlite3` and not `node:sqlite`? ADR 0007 compared the
 * two: `better-sqlite3` has mature Kysely integration, sync API
 * (simpler transactional semantics), and a stable performance
 * baseline. `node:sqlite` was still experimental at pin time.
 *
 * Runtime pragmas: ADR 0007 § "SQLite runtime pragmas" enumerates a
 * fixed set every connection must run before accepting a query. The
 * defaults SQLite ships with (`journal_mode=delete`, `foreign_keys=off`,
 * `busy_timeout=0`) disagree with what the architecture's concurrency
 * + correctness model assumes. `applyRuntimePragmas` is called here
 * so a caller can never hold a handle with a half-configured engine.
 */

import type { WorkspaceId } from "@editorzero/ids";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { Database as DatabaseSchema } from "../schema";
import { createTenantScopedDb, type TenantScopedDb } from "../tenant";

export interface SqliteDriverOptions {
  /** Path to the SQLite file, or `":memory:"` for unit tests. */
  readonly path: string;
  /** Open read-only (e.g. mirror-side projections). Default false. */
  readonly readonly?: boolean;
}

export interface SqliteDriver {
  /** Workspace-scoped handle; every query auto-applies `workspace_id`. */
  scoped(workspace_id: WorkspaceId): TenantScopedDb;
  /** Shut down Kysely + the underlying SQLite connection. */
  close(): Promise<void>;
  /**
   * Raw sync DDL / migration escape hatch. Not for capability handlers
   * — `no-raw-kysely-outside-db` (coherence script; future arch-lint)
   * keeps raw Kysely imports pinned to `packages/db/**`, and a
   * companion rule will narrow this method's call sites to migrations
   * and test setup. Used by Atlas migration application and test setup.
   */
  exec(sql: string): void;
  /**
   * Returns the effective value of a PRAGMA on the underlying connection.
   * Exposed so tests and operational probes can confirm ADR 0007 pragmas
   * actually took effect (e.g. assert `journal_mode = wal`). Intentionally
   * narrow: callers pass a name, not arbitrary SQL.
   */
  pragma(name: string): unknown;
}

/**
 * ADR 0007 runtime pragmas split by whether they mutate on-disk state.
 * `:memory:` and `readonly` databases silently ignore the write-side
 * set; the read-side set is safe everywhere.
 */
const WRITE_SIDE_PRAGMAS = [
  // WAL gives concurrent readers + one writer, which is what the
  // write-path-tx + replay-reader workload assumes. Durability floor
  // is paired with `synchronous=NORMAL`.
  "journal_mode = WAL",
  // NORMAL is safe under WAL: fsync on commit, not on every page
  // write. Losing the last few seconds of transactions after a power
  // cut is the tradeoff; we run async replication to cover that
  // window (§18.1).
  "synchronous = NORMAL",
  // Check-point ~every 1000 frames (~4 MB at 4 KiB pages). Keeps the
  // `-wal` file from unbounded growth under sustained write load.
  "wal_autocheckpoint = 1000",
  // 64 MiB journal-size ceiling (64 * 1024 * 1024). Matches §18.1's
  // backup-boundary assumption; above this, checkpoints reclaim space
  // in one pass instead of amortised.
  "journal_size_limit = 67108864",
] as const;

const READ_SIDE_PRAGMAS = [
  // FK cascade + integrity. Default OFF in SQLite; must be set per
  // connection — it is not persisted in the db header.
  "foreign_keys = ON",
  // 5s busy wait on contended writes before SQLITE_BUSY bubbles up.
  // The write-path tx is short-lived and the wait rarely hits the
  // ceiling; the alternative (instant BUSY failure) is far worse
  // for capability handlers that retry.
  "busy_timeout = 5000",
] as const;

function applyRuntimePragmas(conn: BetterSqlite3.Database, readonly: boolean): void {
  if (!readonly) {
    for (const stmt of WRITE_SIDE_PRAGMAS) conn.pragma(stmt);
  }
  for (const stmt of READ_SIDE_PRAGMAS) conn.pragma(stmt);
}

export function createSqliteDriver(options: SqliteDriverOptions): SqliteDriver {
  const readonly = options.readonly ?? false;
  const conn = new BetterSqlite3(options.path, { readonly });
  applyRuntimePragmas(conn, readonly);
  const dialect = new SqliteDialect({ database: conn });
  const base = new Kysely<DatabaseSchema>({ dialect });

  return {
    scoped: (workspace_id) => createTenantScopedDb(base, workspace_id),
    close: async () => {
      await base.destroy();
    },
    exec: (sql) => {
      conn.exec(sql);
    },
    pragma: (name) => conn.pragma(name),
  };
}
