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
}

export function createSqliteDriver(options: SqliteDriverOptions): SqliteDriver {
  const conn = new BetterSqlite3(options.path, { readonly: options.readonly ?? false });
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
  };
}
