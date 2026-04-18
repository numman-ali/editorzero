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
import {
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  type QueryCompiler,
  SqliteDialect,
  type Transaction,
  type TransactionSettings,
} from "kysely";

import type { SystemDatabase } from "../schema";
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
  /**
   * Unscoped `Kysely<SystemDatabase>` — full table surface, no
   * plugin, no `workspace_id` rewriting. This is the dispatcher /
   * outbox-poller / audit-writer escape hatch, used for the
   * write-path tx (`doc_updates` + `outbox` + `audit_events` +
   * `doc_counters.next_seq` allocation in a single commit) and for
   * the system-level poller that drains `outbox` across workspaces.
   *
   * Not for capability handlers. `no-raw-kysely-outside-db`
   * (coherence script today; future arch-lint) pins imports of
   * `SystemDatabase` / `Kysely` to `packages/db/**` + the dispatcher
   * / runtime / audit-writer packages. Composition code hands the
   * result of `system()` to those specific consumers; handlers
   * receive `scoped()`.
   */
  system(): Kysely<SystemDatabase>;
  /**
   * Run `fn` inside a single SQL transaction against the system DB
   * (SQL-side of F31 / ADR 0018 write-path tx; see §6.4). Commits when
   * `fn` resolves; rolls back if `fn` rejects. The transaction is
   * opened with `BEGIN IMMEDIATE` — signalled via
   * `setIsolationLevel("serializable")`, which
   * `EditorZeroSqliteDriver.beginTransaction` maps to the immediate
   * begin mode. Writer contention therefore surfaces at tx start
   * (bounded by `busy_timeout`) rather than mid-tx — §6.4 relies on
   * this for gapless `doc_counters.next_seq` allocation + outbox
   * forwarding. Other callers of `system().transaction()` /
   * `scoped().transaction()` use the default DEFERRED begin, so read
   * transactions don't grab the RESERVED lock.
   *
   * The tx handle is a `Transaction<SystemDatabase>`, which extends
   * `Kysely<SystemDatabase>`:
   *  - Pass it to `createTenantScopedDb(tx, workspace_id)` to get a
   *    handler-visible `TenantScopedDb` whose writes commit/rollback
   *    atomically with the rest of the tx.
   *  - Use it directly for system-level writes (`audit_events`,
   *    `outbox`, `doc_counters`) that the dispatcher and write-path
   *    composition packages own.
   *
   * **Scope.** This is the SQL-only half of the write-path tx. For
   * content mutations (`doc.*` that call `ctx.transact`), CRDT-side
   * atomicity is orchestrated by the Hocuspocus `onStoreDocument` hook
   * that lands in P3.6c — at which point the Y.Doc persist runs inside
   * the same SQL tx this helper opens. Metadata-only mutations
   * (`block.set_visibility`, `doc.publish`, `collection.*`) are fully
   * covered by this primitive today.
   *
   * Keeping the tx entry point on the driver (instead of exporting raw
   * Kysely `transaction()` usage outside `packages/db`) preserves the
   * `no-raw-kysely-outside-db` discipline.
   */
  withSystemTx<T>(fn: (tx: Transaction<SystemDatabase>) => Promise<T>): Promise<T>;
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

/**
 * editorzero SQLite dialect (architecture.md §6.4 + §6.5).
 *
 * Extends Kysely's `SqliteDialect` with two project-specific behaviours
 * layered on top of the stock driver:
 *
 * 1. **Isolation-level-gated `BEGIN IMMEDIATE`.** When a transaction
 *    is opened with `isolationLevel: "serializable"` — the signal
 *    `withSystemTx` uses via `setIsolationLevel("serializable")` —
 *    begin SQL becomes `BEGIN IMMEDIATE`. All other transactions fall
 *    through to the stock `SqliteDriver.beginTransaction`, which uses
 *    the default DEFERRED begin. This keeps the aggressive lock
 *    posture scoped to the write-path tx: read transactions opened
 *    via `system().transaction()` or `scoped().transaction()` don't
 *    contend on the RESERVED lock, and readonly connections can still
 *    open read-only transactions without needing a writer lock.
 *
 *    Why IMMEDIATE on the write path: §6.4 pins it there because
 *    `doc_counters` allocation and outbox forwarding use
 *    SELECT-then-UPDATE. Under plain DEFERRED `BEGIN`, a concurrent
 *    writer can lock-upgrade between the SELECT and the UPDATE,
 *    deadlocking the second tx with SQLITE_BUSY mid-commit.
 *    IMMEDIATE takes the RESERVED lock at BEGIN time — contention
 *    surfaces at tx start (retryable, bounded by `busy_timeout`)
 *    instead of mid-tx.
 *
 * 2. **Savepoint passthrough.** The stock `SqliteDriver` implements
 *    `savepoint` / `rollbackToSavepoint` / `releaseSavepoint` — these
 *    are the hooks Kysely uses when a `ControlledTransaction` (from
 *    `startTransaction()`) issues `SAVEPOINT` / `ROLLBACK TO` /
 *    `RELEASE`. The wrap forwards each. Without forwarding, Kysely's
 *    internal optional-chain on the wrapped driver would silently
 *    no-op these calls — they'd return successfully while issuing no
 *    SQL, and writes intended to be rolled back would persist. The
 *    `Driver` interface marks these optional; the inner driver
 *    implements them unconditionally.
 */
class EditorZeroSqliteDialect extends SqliteDialect {
  override createDriver(): Driver {
    return new EditorZeroSqliteDriver(super.createDriver());
  }
}

class EditorZeroSqliteDriver implements Driver {
  constructor(private readonly inner: Driver) {}
  init(): Promise<void> {
    return this.inner.init();
  }
  acquireConnection(): Promise<DatabaseConnection> {
    return this.inner.acquireConnection();
  }
  releaseConnection(connection: DatabaseConnection): Promise<void> {
    return this.inner.releaseConnection(connection);
  }
  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    if (settings.isolationLevel === "serializable") {
      await connection.executeQuery(CompiledQuery.raw("begin immediate"));
      return;
    }
    await this.inner.beginTransaction(connection, settings);
  }
  commitTransaction(connection: DatabaseConnection): Promise<void> {
    return this.inner.commitTransaction(connection);
  }
  rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    return this.inner.rollbackTransaction(connection);
  }
  savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    return this.inner.savepoint?.(connection, savepointName, compileQuery) ?? Promise.resolve();
  }
  rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    return (
      this.inner.rollbackToSavepoint?.(connection, savepointName, compileQuery) ?? Promise.resolve()
    );
  }
  releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    return (
      this.inner.releaseSavepoint?.(connection, savepointName, compileQuery) ?? Promise.resolve()
    );
  }
  destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

export function createSqliteDriver(options: SqliteDriverOptions): SqliteDriver {
  const readonly = options.readonly ?? false;
  const conn = new BetterSqlite3(options.path, { readonly });
  applyRuntimePragmas(conn, readonly);
  const dialect = new EditorZeroSqliteDialect({ database: conn });
  const base = new Kysely<SystemDatabase>({ dialect });

  return {
    scoped: (workspace_id) => createTenantScopedDb(base, workspace_id),
    system: () => base,
    // `setIsolationLevel("serializable")` is the write-path-tx signal
    // `EditorZeroSqliteDriver.beginTransaction` listens for — it
    // promotes this tx to `BEGIN IMMEDIATE`. Without the signal, the
    // driver delegates to the stock `SqliteDriver` which uses a
    // DEFERRED begin (the right default for every other transaction
    // opened through `system()` / `scoped()`).
    withSystemTx: (fn) => base.transaction().setIsolationLevel("serializable").execute(fn),
    close: async () => {
      await base.destroy();
    },
    exec: (sql) => {
      conn.exec(sql);
    },
    pragma: (name) => conn.pragma(name),
  };
}
