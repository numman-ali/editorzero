/**
 * `@editorzero/db` — public barrel.
 *
 * Exports only the tenant-scoped surface + driver factories. The
 * unscoped `Kysely<Database>` base instance is intentionally *not*
 * exported; downstream packages receive `TenantScopedDb` from the
 * driver's `scoped(workspace_id)` method and have no way to reach
 * the unscoped handle. The forthcoming arch-lint rule
 * `no-raw-kysely-outside-db` enforces that `Kysely` and `sql<T>`
 * imports are legal only within this package.
 */

export type { SqliteDriver, SqliteDriverOptions } from "./drivers/sqlite";
export { createSqliteDriver } from "./drivers/sqlite";
export type { Database, DocsTable, TenantScopedTable } from "./schema";
export { TENANT_SCOPED_TABLES } from "./schema";
export type { TenantScopedDb } from "./tenant";
export {
  createTenantScopedDb,
  TenantScopeViolationError,
  WorkspaceScopingPlugin,
} from "./tenant";
