/**
 * `@editorzero/db` — public barrel.
 *
 * Exports only the tenant-scoped surface + driver factories. The
 * unscoped `Kysely<Database>` base instance is intentionally *not*
 * exported; downstream packages receive `TenantScopedDb` from the
 * driver's `scoped(workspace_id)` method and have no way to reach
 * the unscoped handle. The `no-raw-kysely-outside-db` rule (enforced
 * today by `scripts/coherence.ts`; future home `@editorzero/arch-lint`)
 * prevents any `Kysely` / `sql<T>` import outside this package.
 */

export { asAuditTx, createAuditWriter } from "./audit-writer";
export { onConflictPersonalSpaceDoNothing } from "./conflict-targets";
export { countTableRows } from "./count-rows";
export { createDocUpdatesReader, type DocUpdatesReader } from "./doc-updates-reader";
export {
  createDocUpdatesWriter,
  type DocUpdatesWriter,
  type DocUpdateWriteInput,
  type DocUpdateWriteResult,
} from "./doc-updates-writer";
export type { PostgresDriver, PostgresDriverOptions } from "./drivers/postgres";
export { createPostgresDriver } from "./drivers/postgres";
export { FULL_DDL as POSTGRES_FULL_DDL } from "./drivers/postgres-ddl";
export type { SqliteDriver, SqliteDriverOptions } from "./drivers/sqlite";
export { createSqliteDriver } from "./drivers/sqlite";
export {
  AUDIT_EVENTS_DDL,
  COLLECTIONS_DDL,
  DOC_COUNTERS_DDL,
  DOC_SNAPSHOTS_DDL,
  DOC_UPDATES_DDL,
  DOCS_DDL,
  FULL_DDL as SQLITE_FULL_DDL,
  GRANTS_DDL,
  OUTBOX_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  WORKSPACE_MEMBERS_DDL,
  WORKSPACES_DDL,
} from "./drivers/sqlite-ddl";
export { ensureSchema } from "./ensure-schema";
export { createLoadRoles, type LoadRoles, type LoadRolesDriver } from "./load-roles";
export { createOutboxWriter, type OutboxAppendInput, type OutboxWriter } from "./outbox-writer";
export { createQueryFaultPlugin, describeQueryNode, type QueryTag } from "./query-fault";
export type {
  AuditEventsTable,
  CollectionsTable,
  Database,
  DocCountersTable,
  DocSnapshotsTable,
  DocsTable,
  DocUpdatesTable,
  GrantsTable,
  OutboxTable,
  SpaceMembersTable,
  SpacesTable,
  SystemDatabase,
  SystemDb,
  TenantScopeColumn,
  TenantScopedTable,
  WorkspaceMembersTable,
  WorkspacesTable,
} from "./schema";
export { TENANT_SCOPE_COLUMNS } from "./schema";
export type { TenantScopedDb } from "./tenant";
export {
  createTenantScopedDb,
  TenantScopeViolationError,
  WorkspaceScopingPlugin,
} from "./tenant";
