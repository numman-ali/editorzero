/**
 * Hand-written `Database` schema for v1 (architecture.md §3.5 – §3.7).
 * The long-term story is: Atlas owns `packages/db/src/schema/*.sql`;
 * `kysely-codegen` generates `packages/db/src/generated/*.ts` from the
 * applied Atlas schema (architecture.md §16.9). Until that pipeline
 * lands, this file carries the minimal shape the P3.5 "create doc,
 * read doc" slice needs. When codegen comes online, this file will be
 * replaced by a re-export from `./generated`.
 *
 * Only `docs` is declared here. Other tables (`blocks`, `audit_events`,
 * `doc_snapshots`, `doc_updates`, the outbox, …) land in subsequent
 * P3.5 sub-slices as they are touched.
 *
 * `TENANT_SCOPED_TABLES` is the authoritative list the
 * `WorkspaceScopingPlugin` reads. A table listed here gets its
 * `workspace_id` predicate auto-injected on SELECT/UPDATE/DELETE and
 * forced into INSERT values; any new tenant-scoped table must be added
 * to this list *at the same commit* as its interface declaration. The
 * integration test in `tenant.unit.test.ts` enumerates every member of
 * this list against both drivers to catch drift.
 */

import type { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";

/**
 * Tables the tenant-scoping plugin enforces `workspace_id` predicates
 * on. Every entry must have a `workspace_id` column of type
 * `WorkspaceId`. Non-tenant-scoped tables (e.g. Better Auth's
 * `session` / `account`) are queried without the plugin.
 */
export const TENANT_SCOPED_TABLES = ["docs"] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/**
 * `docs` — canonical metadata row per document (architecture.md §3.5).
 *
 * `title` is a CRDT projection rebuilt by the snapshot job; it is
 * written at `doc.create` seed time so listings / search don't have to
 * open the Y.Doc. The authoritative title lives in the document's
 * `title` block (ADR 0013 / 0018).
 *
 * Timestamps are epoch-ms `number`s; SQLite and Postgres both store
 * them as `INTEGER` / `BIGINT` and Kysely maps them to `number` on
 * read. The project chose epoch-ms over `Date` to avoid TZ drift and
 * keep ordering arithmetic cheap.
 */
export interface DocsTable {
  readonly id: DocId;
  readonly workspace_id: WorkspaceId;
  readonly collection_id: CollectionId | null;
  readonly title: string;
  readonly slug: string;
  readonly order_key: string;
  readonly visibility: "workspace" | "public" | "private";
  readonly visibility_version: number;
  readonly created_by: UserId;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
}

/**
 * Root schema type. Kysely consumers parametrise as `Kysely<Database>`.
 * Extend by adding table interfaces here; the plugin's `workspace_id`
 * enforcement keys off `TENANT_SCOPED_TABLES`, not this type.
 */
export interface Database {
  readonly docs: DocsTable;
}
