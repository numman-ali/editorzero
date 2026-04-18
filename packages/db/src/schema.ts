/**
 * Hand-written `Database` schema for v1 (architecture.md §3.5 – §3.11).
 * The long-term story is: Atlas owns `packages/db/src/schema/*.sql`;
 * `kysely-codegen` generates `packages/db/src/generated/*.ts` from the
 * applied Atlas schema (architecture.md §16.9). Until that pipeline
 * lands, this file carries the shape the P3.5 "create doc, read doc"
 * slice needs. When codegen comes online, this file will be replaced
 * by a re-export from `./generated`.
 *
 * `TENANT_SCOPED_TABLES` is the authoritative list the
 * `WorkspaceScopingPlugin` reads. A table listed here gets its
 * `workspace_id` predicate auto-injected on SELECT/UPDATE/DELETE and
 * forced into INSERT values; any new tenant-scoped table must be added
 * to this list *at the same commit* as its interface declaration. The
 * integration test in `tenant.unit.test.ts` enumerates every member of
 * this list against both drivers to catch drift.
 *
 * **Two tables are deliberately NOT in `TENANT_SCOPED_TABLES`:**
 *  - `doc_counters` has no `workspace_id` column (§6.4 — scope is
 *    derivable via the `doc_id → docs.workspace_id` FK; including it
 *    here would need the plugin to synthesize scopes from joins, which
 *    F87 deliberately rejected).
 *  - `outbox.workspace_id` is nullable (system-level events carry
 *    `NULL`; §6.3) and the poller reads across workspaces, so the
 *    plugin's INSERT-injection + SELECT-predicate model does not fit.
 *    Handler-emitted outbox writes go through unscoped Kysely inside
 *    the dispatcher's write-path tx; the background poller is a
 *    system-level service that uses the unscoped base handle.
 */

import type { AgentId, CollectionId, DocId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { CapabilityCategory, SubjectKind } from "@editorzero/scopes";

/**
 * Tables the tenant-scoping plugin enforces `workspace_id` predicates
 * on. Every entry must have a `workspace_id` column of type
 * `WorkspaceId` (non-nullable). Non-tenant-scoped tables (`doc_counters`,
 * `outbox`, Better Auth's `session` / `account`) are queried without
 * the plugin.
 */
export const TENANT_SCOPED_TABLES = [
  "docs",
  "doc_snapshots",
  "doc_updates",
  "audit_events",
] as const;

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
 * `doc_snapshots` — compacted Y.Doc state per `seq` boundary
 * (architecture.md §3.7). `state` is `Y.encodeStateAsUpdate(yDoc)` —
 * the full Y.Doc encoded as a single delta-from-empty update. Written
 * by `onStoreDocument` (debounced, non-concurrent per doc) during
 * compaction; read by hydration + versioning.
 */
export interface DocSnapshotsTable {
  readonly id: string;
  readonly doc_id: DocId;
  readonly workspace_id: WorkspaceId;
  readonly seq: number;
  readonly state: Uint8Array;
  readonly created_at: number;
}

/**
 * `doc_updates` — append-only journal of Yjs updates per doc
 * (architecture.md §3.7). One row per accepted `editor.transact`. Seq
 * is allocated by the `doc_counters` row-lock (§6.4) inside the
 * write-path tx that also writes `audit_events` + `outbox` (F31).
 * `delete_after` carries the GC horizon the reaper honors after
 * compaction tombstones the row (§18.1).
 */
export interface DocUpdatesTable {
  readonly id: string;
  readonly doc_id: DocId;
  readonly workspace_id: WorkspaceId;
  readonly seq: number;
  readonly update_blob: Uint8Array;
  readonly principal_kind: "user" | "agent";
  readonly principal_id: UserId | AgentId;
  readonly session_id: string | null;
  readonly created_at: number;
  readonly delete_after: number | null;
}

/**
 * `doc_counters` — per-doc `next_seq` row-lock target (§6.4). Single
 * row per doc; `INSERT` in the same tx as the `docs` INSERT (priming
 * `next_seq = 1`). Seq allocation uses `SELECT … FOR UPDATE` +
 * `UPDATE next_seq = next_seq + 1` in the same tx as the
 * corresponding `doc_updates` INSERT — gapless on rollback.
 *
 * NOT tenant-scoped: no `workspace_id` column; scope is derived via
 * the `doc_id → docs.workspace_id` FK. The plugin deliberately does
 * NOT follow FKs (F87 accepted that limitation) — callers that touch
 * `doc_counters` do so inside the write-path tx which has already
 * proven the `doc_id` belongs to the principal's workspace via an
 * earlier `docs` read.
 */
export interface DocCountersTable {
  readonly doc_id: DocId;
  readonly next_seq: number;
  readonly updated_at: number;
}

/**
 * `audit_events` — every outcome of every capability invocation
 * (architecture.md §3.11). Never soft-deleted, never hard-deleted
 * (ADR 0017). Columns mirror `AuditWriteInput` field-for-field
 * (F90): `category` + `collapsed_count` are load-bearing for
 * analytic partitioning and ADR 0009 read-collapse respectively.
 *
 * `effect` is `TEXT JSON` — the minimal `AuditEffect` (allow),
 * `AuditDeny` (deny), or `AuditError` (error) projection the
 * capability declared. Readers `JSON.parse` and discriminate on
 * `kind`. `deny_reason` is a denormalized column so per-reason
 * queries are indexable without JSON extraction.
 *
 * `subject_id` is typed as `string` because audit rows from
 * different capabilities carry heterogeneous ID brands (`DocId`,
 * `AgentId`, `UserId`, …). The F90 disposition resolved this as a
 * query-time narrowing concern: queries that filter on `subject_id`
 * alone MUST also filter on `subject_kind` (lint rule
 * `no-raw-audit-events-query` keeps direct access pinned to
 * `packages/db/repos/audit.ts`).
 */
export interface AuditEventsTable {
  readonly id: string;
  readonly workspace_id: WorkspaceId;
  readonly capability_id: string;
  readonly category: CapabilityCategory;
  readonly principal_kind: "user" | "agent";
  readonly principal_id: UserId | AgentId;
  readonly acting_as_user_id: UserId | null;
  readonly session_id: string | null;
  readonly token_id: TokenId | null;
  readonly subject_kind: SubjectKind;
  readonly subject_id: string | null;
  readonly outcome: "allow" | "deny" | "error";
  readonly deny_reason: string | null;
  readonly input_hash: string;
  readonly effect: string;
  readonly duration_ms: number;
  readonly trace_id: string | null;
  readonly created_at: number;
  readonly collapsed_count: number;
}

/**
 * `outbox` — transactional-outbox rows emitted in the write-path tx
 * (architecture.md §6.3, F10 + F74). A per-process poller drains
 * unforwarded rows every 250 ms and calls `JobService.enqueue` with
 * `singletonKey = outbox.id` for idempotency.
 *
 * NOT tenant-scoped: `workspace_id` is nullable (system-level events
 * carry `NULL`), and the poller must read across workspaces.
 * Handler-emitted rows (from `ctx.outbox`) DO set `workspace_id` —
 * the dispatcher's write-path tx populates it from the principal's
 * tenant context before the INSERT.
 */
export interface OutboxTable {
  readonly id: string;
  readonly workspace_id: WorkspaceId | null;
  readonly event: string;
  readonly payload: string;
  readonly created_at: number;
  readonly forwarded_at: number | null;
  readonly forwarded_to: string | null;
}

/**
 * Handler-visible schema. Every table here is tenant-scoped
 * (`TENANT_SCOPED_TABLES` is a subset of `keyof Database` by
 * construction) and every query through `TenantScopedDb` is
 * auto-filtered on `workspace_id`.
 *
 * `doc_counters` and `outbox` are deliberately *absent* from this
 * type (F98). They are write-path internals that the dispatcher, the
 * outbox poller, and the audit writer reach through `SystemDatabase`
 * instead — a handler with a `TenantScopedDb` must not even be able
 * to type-check a reference to them. The scoping plugin is a runtime
 * guard; narrowing the type is the compile-time guard. Defence in
 * depth against a capability handler that accidentally escapes its
 * tenant via an internal table.
 *
 * Extend by adding tenant-scoped table interfaces here AND to
 * `TENANT_SCOPED_TABLES`. Internal tables go on `SystemDatabase`.
 */
export interface Database {
  readonly docs: DocsTable;
  readonly doc_snapshots: DocSnapshotsTable;
  readonly doc_updates: DocUpdatesTable;
  readonly audit_events: AuditEventsTable;
}

/**
 * The internal, full-fat schema. Callers: dispatcher write-path tx
 * (inserts `doc_updates` + `outbox` + `audit_events` + allocates
 * `doc_counters.next_seq`), outbox poller, audit writer, migration
 * runner. These callers sit *inside* `packages/db`'s trust boundary
 * or are trusted peers (the dispatcher) that the composition package
 * (`@editorzero/runtime`) wires up from the driver's `system()`
 * method.
 *
 * This type extends `Database`, so `Kysely<SystemDatabase>` can run
 * every query `Kysely<Database>` can — but also the write-path
 * internals. Handler code never receives `Kysely<SystemDatabase>`;
 * `no-raw-kysely-outside-db` (coherence script; future arch-lint)
 * pins all imports of this type to the db / dispatcher / runtime /
 * audit-writer packages.
 */
export interface SystemDatabase extends Database {
  readonly doc_counters: DocCountersTable;
  readonly outbox: OutboxTable;
}
