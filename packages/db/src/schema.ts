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

import type {
  AgentId,
  CollectionId,
  DocId,
  GrantId,
  SpaceId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import type {
  AccessMode,
  AgentTokenTier,
  CapabilityCategory,
  GrantRole,
  Role,
  SpaceKind,
  SpaceType,
  SubjectKind,
} from "@editorzero/scopes";
import type { Kysely } from "kysely";

/**
 * Per-table scope column for the tenant-scoping plugin. Every key here
 * is a table the plugin must rewrite on SELECT/UPDATE/DELETE/INSERT;
 * the value names the column the predicate binds to.
 *
 * Almost every tenant-scoped table carries a separate `workspace_id`
 * column (`WorkspaceId` non-nullable). `workspaces` is the lone
 * **self-scoped** exception: its `id` IS the workspace id, so the
 * plugin scopes on `id` instead. Net effect through a tenant-scoped
 * handle is identical — a caller can only ever see their own row.
 *
 * Non-tenant-scoped tables (`doc_counters`, `outbox`, Better Auth's
 * `session` / `account`) are queried without the plugin.
 *
 * Extending this map requires a paired change: add the key here AND
 * the table interface below AND (for `Database`-visible tables) an
 * entry on `Database`. The `satisfies` clause makes that pairing a
 * compile error instead of a convention: a `Database` key missing
 * here fails tsc (a typed-reachable table the plugin would NOT scope
 * — the tenant-leak drift class), and an extra key here that is not
 * on `Database` fails as an excess property. The
 * `tenant-tables.integration.test.ts` drift guard then enumerates
 * every key and fails if a test isn't covering it.
 */
export const TENANT_SCOPE_COLUMNS = {
  collections: "workspace_id",
  docs: "workspace_id",
  doc_snapshots: "workspace_id",
  doc_updates: "workspace_id",
  audit_events: "workspace_id",
  workspace_members: "workspace_id",
  workspaces: "id",
  spaces: "workspace_id",
  space_members: "workspace_id",
  grants: "workspace_id",
  agents: "workspace_id",
  agent_tokens: "workspace_id",
} as const satisfies Record<keyof Database, "workspace_id" | "id">;

export type TenantScopedTable = keyof typeof TENANT_SCOPE_COLUMNS;
export type TenantScopeColumn = (typeof TENANT_SCOPE_COLUMNS)[TenantScopedTable];

/**
 * `collections` — folder-tree primitive for organizing docs
 * (architecture.md §3.5). One row per collection. `parent_id = NULL`
 * means the collection sits at workspace root; otherwise it's a child
 * of the referenced collection. Slug uniqueness is per `(workspace_id,
 * parent_id)` — two siblings can't share a slug, but two cousins in
 * different parents can. The SQL constraint is expressed as two
 * partial unique indexes (one for `parent_id IS NULL`, one for
 * non-null) because `UNIQUE (workspace_id, parent_id, slug)` treats
 * NULL as distinct and would let two root-level collections collide.
 *
 * Soft-delete via `deleted_at` — same 30-day recovery window as docs
 * (ADR 0017). `collection.delete` is **non-cascading** in v1: refuses
 * when the collection has any live child (doc or child collection),
 * returns 409. Restoring a doc or child collection into a deleted
 * parent is also refused (409) — caller restores the parent first.
 * This keeps the audit-effect shape lossless (the `collection.
 * soft_delete` effect carries only the collection_id; no implicit
 * descendant list) and the restore semantics unambiguous.
 */
export interface CollectionsTable {
  readonly id: CollectionId;
  readonly workspace_id: WorkspaceId;
  readonly parent_id: CollectionId | null;
  // Home Space (ADR 0040 Step 4). Nullable while the Space rollout is in
  // flight — pre-Space collections live at workspace root. Handler-
  // enforced, no SQL FK (matching `docs.collection_id`); Collections
  // hold no ACL (B1) — this is pure navigation, never a grant source.
  readonly space_id: SpaceId | null;
  readonly title: string;
  readonly slug: string;
  readonly order_key: string;
  readonly created_by: UserId;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
}

/**
 * `spaces` — the membership ceiling inside the workspace (ADR 0040
 * Model B: Org → Space hard-ceiling → Collection/Doc). A Space is NOT a
 * renamed workspace: `workspaces` stays the physical tenant root, and
 * `spaces` rides `TENANT_SCOPE_COLUMNS` like any other tenant table.
 *
 * `kind`/`owner_user_id` are tied by a table CHECK: a `personal` space
 * carries its owner, a `team` space carries NULL. `baseline_access` is
 * the GrantRole an `open` space confers on Org members who hold no
 * membership row (`closed`/`private` confer nothing implicitly) —
 * 'owner' is deliberately outside the CHECK (an implicit
 * everyone-is-owner baseline is never valid). The Step-6 read-only
 * resolver is the sole consumer of these semantics; until it lands no
 * read path is Space-gated (ADR 0040 fork #2/H9 sequencing).
 *
 * `UNIQUE (id, workspace_id)` exists as the composite-FK target for
 * `space_members` (the F99 tenant-integrity pattern, same as
 * `collections.parent_id`).
 */
export interface SpacesTable {
  readonly id: SpaceId;
  readonly workspace_id: WorkspaceId;
  readonly kind: SpaceKind;
  readonly type: SpaceType;
  readonly owner_user_id: UserId | null;
  readonly name: string;
  readonly slug: string;
  readonly baseline_access: GrantRole;
  readonly created_by: UserId;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
}

/**
 * `space_members` — Space membership (ADR 0040). Mirrors
 * `workspace_members`' composite-PK shape but speaks the GRANT_ROLES
 * ladder, NOT the workspace ROLES vocabulary: the ceiling rule is
 * "a Doc grant may only RAISE a member's role (view→comment/edit/
 * owner)", so membership roles and grant roles must be the same
 * ordered set for the comparison to be meaningful. The composite FK to
 * `spaces(id, workspace_id)` makes a wrong-tenant `space_id` pairing
 * unrepresentable (F99) — the polymorphic `grants` table deliberately
 * CANNOT have this protection, which is why it gets the fuzzer +
 * handler-check compensations instead (H6).
 *
 * No `deleted_at`: membership removal is a hard DELETE (the audit
 * effect carries the preimage — same posture as grant revoke, H1).
 */
export interface SpaceMembersTable {
  readonly workspace_id: WorkspaceId;
  readonly space_id: SpaceId;
  readonly user_id: UserId;
  readonly role: GrantRole;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * `grants` — the single polymorphic ACL table (ADR 0040 fork #3).
 * One row = one positive capability edge: `subject` may act as `role`
 * on `resource`. `is_guest = 1` marks the deliberate cross-Space
 * escape hatch (a principal who is not a member of the resource's
 * Space) — the one row-type that crosses the ceiling, always explicit
 * and audited.
 *
 * v1 enums (open for greenfield WIDENING, never reinterpretation):
 * `resource_kind ∈ {space, doc}` (`collection` reserved — B1),
 * `subject_kind ∈ {user, agent}` (`team` reserved — H13).
 *
 * **No composite FK by design (H6):** a polymorphic `resource_id`
 * cannot carry per-kind composite FKs, so this table forgoes the F99
 * pattern. Compensating controls, named in the ADR and binding:
 * the unique `(workspace_id, resource_kind, resource_id, subject_kind,
 * subject_id)` index (no duplicate edges), the Step-6 isolation-fuzzer
 * property (every `resource_id` resolves within its `workspace_id`),
 * and the Step-8 grant handler's same-tx target-existence check.
 *
 * Hard-DELETE lifecycle (H1): no `deleted_at`, no `updated_at` — a
 * revoke removes the row and the audit effect carries the preimage;
 * grant rows persist through their resource's soft-delete (inert while
 * trashed) so restore recovers the grant set 1:1.
 */
export interface GrantsTable {
  readonly id: GrantId;
  readonly workspace_id: WorkspaceId;
  readonly resource_kind: "space" | "doc";
  readonly resource_id: string;
  readonly subject_kind: "user" | "agent";
  readonly subject_id: string;
  readonly role: GrantRole;
  readonly is_guest: 0 | 1;
  readonly created_by: UserId;
  readonly created_at: number;
}

/**
 * `agents` — agent principals (ADR 0044, amending ADR 0016). One row =
 * one agent identity; credentials live in `agent_tokens` (the lifecycle
 * split: the agent row is *who*, the token is *may-do*).
 *
 * `owner_user_id` is NOT NULL in v1 — every agent has a human owner,
 * which keeps the `created_by` attribution ladder total (an owner-scoped
 * agent's writes attribute to its owner; see `doc.create`). **Owner
 * liveness gates authentication**: bearer resolution joins a live
 * `workspace_members` row for the owner, so a removed member's agents
 * stop resolving without any cascade touching these rows. There is no
 * SQL FK to Better Auth's `user` table (boundary rule, ADR 0030).
 *
 * `revoked_at` is TERMINAL — no un-revoke capability exists by design
 * (a security action, not a trash operation; recovery is recreation
 * under a new id). Grants referencing a revoked agent's id stay as
 * inert rows: subject-id-bound, and server-minted UUIDv7 ids make
 * accidental re-match effectively impossible. The partial-unique name
 * index frees the name on revocation (the established live-name
 * pattern); audit rows carry the stable agent id, never just the name.
 */
export interface AgentsTable {
  readonly id: AgentId;
  readonly workspace_id: WorkspaceId;
  readonly name: string;
  readonly owner_user_id: UserId;
  readonly created_by: UserId;
  readonly created_at: number;
  readonly updated_at: number;
  readonly revoked_at: number | null;
}

/**
 * `agent_tokens` — owned bearer credentials for agents (ADR 0044
 * Decision 1; `@better-auth/api-key` deliberately not adopted). Rows
 * are minted/revoked exclusively through capabilities in the
 * dispatcher tx, so token row + audit row commit atomically
 * (invariant 3).
 *
 * `token_hash` = SHA-256 hex of the full `ez_agent_…` secret, under a
 * GLOBAL unique index (live + revoked rows alike): the schema encodes
 * "one secret resolves to at most one row" — resolution is a
 * full-digest indexed lookup over 256-bit entropy, and a duplicate
 * match is structural corruption by definition. The plaintext secret
 * exists only in the `agent.token_mint` output (show-once); the hash
 * never enters an audit effect — replay reconstructs token rows MINUS
 * this column (secrets are material, not state).
 *
 * `scopes` is a JSON-serialised array bounded by the non-amplification
 * rule (`AGENT_MINTABLE_SCOPES`; agent callers mint ⊆ their own
 * effective scopes). `tier` is the mint-time intent label
 * (`AgentScopeTier | "custom"`) — display/audit record only, never
 * re-derived into scopes (tiers are computed-once at mint).
 *
 * Composite FK to `agents(id, workspace_id)` makes a wrong-tenant
 * `agent_id` pairing unrepresentable (the F99 pattern — `agents` must
 * precede this table in `FULL_DDL`).
 */
export interface AgentTokensTable {
  readonly id: TokenId;
  readonly workspace_id: WorkspaceId;
  readonly agent_id: AgentId;
  readonly token_hash: string;
  readonly token_prefix: string;
  readonly last4: string;
  readonly scopes: string;
  readonly tier: AgentTokenTier;
  readonly created_by: UserId;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
}

/**
 * `docs` — canonical metadata row per document (architecture.md §3.5).
 *
 * `title` is a CRDT projection rebuilt by the snapshot job; it is
 * written at `doc.create` seed time so listings / search don't have to
 * open the Y.Doc. The authoritative title lives in the document's
 * `title` block (ADR 0013 / 0018).
 *
 * `collection_id` places the doc in a collection (nullable — `null`
 * means the doc sits at workspace root). The column is NOT a SQL FK
 * to `collections(id)` today: tests instantiate `DOCS_DDL` in
 * isolation without bringing `COLLECTIONS_DDL` along (12+ test files),
 * so adding a FK would break unrelated test fixtures. Referential
 * integrity is handler-enforced: `doc.create` / `doc.move` SELECT the
 * collection row before writing, and reject with 404 if the
 * collection is missing or soft-deleted. When Atlas takes over
 * (architecture.md §16.9) the FK lands alongside the codegen move.
 *
 * Slug uniqueness is per `(workspace_id, collection_id)` — same
 * NULL-aware partial-index pattern as collections: two sibling docs
 * can't share a slug, but a root doc and a collection-scoped doc
 * can (different uniqueness scopes). Expressed as two partial unique
 * indexes (one for `collection_id IS NULL`, one for non-null).
 * `doc.create` surfaces collision as 409 (SQL UNIQUE violation
 * bubbles through the dispatcher's error projection).
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
  /**
   * Read scope INSIDE the Org (ADR 0040 Step 5 — the `visibility`
   * de-overload): `space` = space-mediated, `private` = allow-list.
   * Orthogonal to publish; no live capability mutates it yet (the mode
   * switch lands with the Step-8 ACL family).
   */
  readonly access_mode: AccessMode;
  /**
   * The public dimension (orthogonal to `access_mode`). Non-null
   * `published_at` ⇒ published; `published_slug` is the workspace-
   * unique public URL segment (`docs_published_slug_unique`). Set by
   * `doc.publish`; cleared by `doc.unpublish` AND `doc.soft_delete`
   * (a trashed doc leaves the public site; restore never
   * surprise-republishes).
   */
  readonly published_slug: string | null;
  readonly published_at: number | null;
  /** Render/cache-invalidation counter (F5) — renamed from `visibility_version` at the Step-5 split. */
  readonly render_version: number;
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
 * `workspace_members` — user↔workspace membership with role
 * (architecture.md §3.4; ADR 0024). One row per active user-per-
 * workspace; `role` is the Layer-1 source the resolver reads at
 * principal-projection time. `ROLE_SCOPES` in
 * `packages/dispatcher/src/gate.ts` maps `Role` → `Scope[]`.
 *
 * Scoped on `workspace_id` via `TENANT_SCOPE_COLUMNS` so every read
 * through `ctx.db` auto-filters to the caller's tenant. The auth
 * resolver still reaches this table via `driver.system()` because it
 * runs *before* a tenant context exists (the resolver is how that
 * context gets minted); the `SystemDatabase` escape hatch remains
 * narrow and single-purpose.
 *
 * `role` typed as `Role` so Kysely selects narrow to the four-value
 * union without a runtime check. The DDL's `CHECK (role IN (…))`
 * constraint is the database-side enforcement; together they keep
 * role drift impossible modulo a migration change.
 *
 * Revive-in-place: the composite PK `(workspace_id, user_id)` means
 * re-adding a soft-deleted member is an UPDATE that clears
 * `deleted_at` (and possibly overwrites `role`), not an INSERT.
 * Codified in the future `workspace.add_member` capability's handler.
 */
export interface WorkspaceMembersTable {
  readonly workspace_id: WorkspaceId;
  readonly user_id: UserId;
  readonly role: Role;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
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
 * `workspaces` — the tenant-scope root (architecture.md §3.2).
 *
 * **Self-scoped.** `id` IS the workspace id; there is no separate
 * `workspace_id` column. `TENANT_SCOPE_COLUMNS.workspaces === "id"`
 * tells `WorkspaceScopingPlugin` to emit `id = <scope>` predicates
 * rather than the usual `workspace_id = <scope>`. A handler holding
 * a `TenantScopedDb` can therefore only ever see or update its own
 * workspace row — the plugin forces the self-reference into every
 * SELECT/UPDATE/DELETE and INSERT.
 *
 * **Creation path.** `workspace.create` (future slice, humanOnly +
 * admin-gated) cannot run through the scoped handle: the plugin
 * would force `id = principal.workspace_id` into the INSERT, which
 * is precisely wrong — a creator is minting a *new* workspace, not
 * their own. That capability goes through the system handle by
 * design. Today's only writer is the Better Auth `user.create.after`
 * hook, which already uses `driver.system()` for its bootstrap
 * INSERT + `workspace_members` pair.
 *
 * **`diagnostic_salt`.** Per-workspace HMAC salt (F64), used by
 * future `admin.diagnose` for content-hash redaction before export.
 * 16 cryptographically-random bytes minted at workspace creation;
 * rotated by a future `admin.secret_rotate --kind=diagnostic_salt`.
 * No consumer in v1 but the column is NOT decorative — architecture
 * §3.2 already references it.
 *
 * **`settings`.** JSON-serialised opaque map (defaults to `'{}'`).
 * `workspace.update` validates the input as a plain object at the
 * capability boundary, then `JSON.stringify`s for storage.
 *
 * **No `updated_at`.** Matches architecture.md §3.2 exactly; workspace
 * reads are single-row-by-principal so there is no listing-by-freshness
 * query today. Addable as an additive migration when needed.
 */
export interface WorkspacesTable {
  readonly id: WorkspaceId;
  readonly slug: string;
  readonly name: string;
  readonly trash_retention_days: number;
  readonly diagnostic_salt: Uint8Array;
  readonly created_by: UserId;
  readonly created_at: number;
  readonly deleted_at: number | null;
  readonly settings: string;
}

/**
 * Handler-visible schema. Every table here is tenant-scoped (each key
 * appears in `TENANT_SCOPE_COLUMNS`) and every query through
 * `TenantScopedDb` is auto-filtered on the per-table scope column —
 * `workspace_id` for all but `workspaces` itself, which scopes on `id`.
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
 * `TENANT_SCOPE_COLUMNS`. Internal tables go on `SystemDatabase`.
 */
export interface Database {
  readonly collections: CollectionsTable;
  readonly docs: DocsTable;
  readonly doc_snapshots: DocSnapshotsTable;
  readonly doc_updates: DocUpdatesTable;
  readonly audit_events: AuditEventsTable;
  readonly workspace_members: WorkspaceMembersTable;
  readonly workspaces: WorkspacesTable;
  readonly spaces: SpacesTable;
  readonly space_members: SpaceMembersTable;
  readonly grants: GrantsTable;
  readonly agents: AgentsTable;
  readonly agent_tokens: AgentTokensTable;
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

/**
 * The unscoped system-DB handle type (`Kysely<SystemDatabase>`). Exposed
 * as a named alias so packages outside `packages/db/**` — which the
 * `no-raw-kysely-outside-db` coherence rule forbids from importing
 * `kysely` directly — can still type their deps that receive the handle
 * from composition. Consumers today: `@editorzero/sync` (read-path
 * hydration hook takes an untransacted `SystemDb` to replay committed
 * `doc_updates`); future consumers: any write-path participant that
 * needs to type a dep on the base handle without reaching for raw
 * `Kysely`.
 */
export type SystemDb = Kysely<SystemDatabase>;
