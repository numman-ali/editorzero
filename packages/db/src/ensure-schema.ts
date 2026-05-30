/**
 * Restart-safe schema bootstrap for the SQLite driver.
 *
 * `FULL_DDL` is a plain `CREATE TABLE` sequence — *not* idempotent —
 * so re-applying it to an already-initialised database throws "table
 * already exists". A persistent single-box deploy (ADR 0012 / 0027)
 * restarts against an existing file, so the boot path cannot apply DDL
 * unconditionally. `ensureSchema` applies `FULL_DDL` only when the schema
 * is absent, probed via a sentinel table.
 *
 * This is a bootstrap convenience for the single-box floor, **not** a
 * migration system: schema *evolution* across versions is Atlas's job
 * (AGENTS.md gotchas). A future migration runner supersedes the bare
 * apply here; the absence probe stays correct either way — a migrated
 * database has the sentinel table, so DDL is skipped.
 *
 * Lives in `@editorzero/db` because both the `pragma` probe and the raw
 * DDL `exec` are the driver's own surface, kept inside the package the
 * `no-raw-kysely-outside-db` rule pins them to.
 */

import type { SqliteDriver } from "./drivers/sqlite";
import { FULL_DDL } from "./drivers/sqlite-ddl";

/**
 * A core table present iff the schema has been applied. `workspaces` is
 * the tenant root every other table foreign-keys toward, so its presence
 * is a sound proxy for "schema initialised".
 */
const SENTINEL_TABLE = "workspaces";

/**
 * Apply the full DDL to `driver` if (and only if) the schema is absent.
 * Idempotent across restarts: a no-op once the sentinel table exists.
 */
export function ensureSchema(driver: SqliteDriver): void {
  // `PRAGMA table_info(<missing>)` returns zero rows (no error) when the
  // table is absent, and the column list when present.
  const info = driver.pragma(`table_info(${SENTINEL_TABLE})`);
  const present = Array.isArray(info) && info.length > 0;
  if (!present) {
    driver.exec(FULL_DDL);
  }
}
