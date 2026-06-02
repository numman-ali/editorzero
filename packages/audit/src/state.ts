/**
 * `PersistentWorkspaceState` — the projection invariant 3a reconstructs.
 *
 * Invariant 3a (AGENTS.md / architecture.md §9.1): *"every mutation
 * produces exactly one audit entry; the audit log alone reconstructs
 * final state."* This module defines what *"final state"* means for the
 * replay reducer in `./reducer.ts`: the **semantic metadata projection**
 * of a workspace — which workspaces / members / collections / docs exist,
 * their identity, hierarchy, doc read-scope, attribution, and whether they
 * are soft-deleted.
 *
 * It is a *projection*, not a row-for-row mirror of `@editorzero/db`. The
 * reducer folds the audit **row** (envelope + effect — see `ReplayRow`),
 * so `created_by` reconstructs from the envelope principal even though the
 * `doc.create` / `collection.create` effect bodies omit it. The exclusion
 * list below *is* the honesty surface of invariant 3a, so it is enumerated
 * here rather than left implicit:
 *
 *  1. **Server-clock timestamps are NOT reconstructable — by construction.**
 *     - `*.created_at`, `*.updated_at`, and the *value* of `*.deleted_at`.
 *       Two independent clocks are involved: the handler stamps the entity
 *       row via `ctx.now()`, the audit writer stamps the audit row via its
 *       own `now()` — *different ticks*. And the create/soft_delete effect
 *       bodies do not carry a timestamp. So the audit log cannot reproduce
 *       these exact values. The projection therefore models soft-delete as
 *       a **boolean** (`deleted`), which IS reconstructable (a `soft_delete`
 *       effect sets it true, `restore`/`create` set it false), and drops
 *       `created_at`/`updated_at` entirely. **Open question for review:** if
 *       invariant 3a is meant to include timestamps, the create/delete
 *       effects must start carrying them — a deliberate effect-shape change,
 *       not a reducer change. Flagged, not silently assumed.
 *
 *  2. **Server-minted secrets — never audit-derived, by design.**
 *     - `workspaces.diagnostic_salt` (16 random bytes, F64). Not domain
 *       state; replaying the log must NOT reproduce a secret.
 *
 *  3. **Create-time defaults the create effect does not carry.**
 *     - `workspaces.trash_retention_days`, `workspaces.settings`.
 *       `workspace.create` carries only `{workspace_id, slug, name,
 *       created_by}`; the defaults live in the DDL. They enter the
 *       projection when `workspace.update` field-patch coverage lands (the
 *       update effect carries the patch). Until then: excluded, documented.
 *
 *  4. **Monotonic bookkeeping — derivable, deferred.**
 *     - `docs.visibility_version` (count of publish/unpublish/delete/
 *       restore effects). Reconstructable by replay derivation; deferred to
 *       keep the first contract tight. Promoting it is additive.
 *
 * **Genesis caveat (also a review question).** The signup bootstrap writes
 * the `workspaces` row + the owner `workspace_members` row directly via
 * `driver.system()` in a Better Auth after-hook — it does NOT dispatch a
 * capability, so it emits NO `audit_events`. Those rows are therefore part
 * of *genesis* state, not audit-reconstructable. Either the bootstrap
 * should emit `workspace.create` + `member.add` effects (closing invariant
 * 3 for signup), or genesis is an accepted exception that replay must be
 * seeded with. Flagged for the same reason as the timestamp question.
 *
 * **The `docs` read-scope field is the ADR 0040 Step-5 seam.** Today it is
 * the live overloaded `visibility ∈ {workspace, public, private}` column;
 * Step 5 splits it into `access_mode ∈ {space, private}` + `published_at`.
 * The reducer sets this field in exactly two places (`doc.create` initial,
 * `doc.publish`/`doc.unpublish` flip), so the split lands as an additive
 * transform — not a reducer rewrite. The property compares this field
 * against whatever the live `docs` columns are, so it tracks the schema.
 */

import type { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AuditRecord, DocVisibility, Role } from "./types";

/** Reconstructed `workspaces` projection (excludes salt/defaults/timestamps). */
export interface WorkspaceState {
  readonly id: WorkspaceId;
  readonly slug: string;
  readonly name: string;
  readonly created_by: UserId;
  readonly deleted: boolean;
}

/** Reconstructed `workspace_members` projection. */
export interface MemberState {
  readonly workspace_id: WorkspaceId;
  readonly user_id: UserId;
  readonly role: Role;
  readonly deleted: boolean;
}

/** Reconstructed `collections` projection. */
export interface CollectionState {
  readonly id: CollectionId;
  readonly workspace_id: WorkspaceId;
  readonly parent_id: CollectionId | null;
  readonly title: string;
  readonly slug: string;
  readonly order_key: string;
  readonly created_by: UserId;
  readonly deleted: boolean;
}

/** Reconstructed `docs` metadata projection. */
export interface DocState {
  readonly id: DocId;
  readonly workspace_id: WorkspaceId;
  readonly collection_id: CollectionId | null;
  /**
   * Title as set by *metadata* effects (`doc.create`, `doc.rename`).
   * NOTE: `docs.title` is *also* mutated out-of-band by the snapshot
   * projection job when the title *block* is edited (CRDT content —
   * invariant 3b). The metadata-replay property reconstructs title from
   * the metadata effects and deliberately does not interleave content
   * edits; reconciling the projection-job path is the `content` class's
   * concern, not this reducer's. Documented 3a/3b boundary.
   */
  readonly title: string;
  readonly slug: string;
  readonly order_key: string;
  /**
   * Doc read-scope. The ADR 0040 Step-5 seam (see file doc): today the
   * live `visibility` enum; Step 5 adds `access_mode` + `published_at`
   * here additively.
   */
  readonly visibility: DocVisibility;
  readonly created_by: UserId;
  readonly deleted: boolean;
}

/**
 * The reconstructed projection. Entities are keyed by id (members by a
 * `${workspace_id}::${user_id}` composite) so equality is order-
 * independent — a deep-equal against the same projection built from the
 * live DB is the invariant-3a assertion.
 */
export interface PersistentWorkspaceState {
  readonly workspaces: Readonly<Record<string, WorkspaceState>>;
  readonly members: Readonly<Record<string, MemberState>>;
  readonly collections: Readonly<Record<string, CollectionState>>;
  readonly docs: Readonly<Record<string, DocState>>;
}

/** The starting point for a replay — an empty workspace universe. */
export const EMPTY_STATE: PersistentWorkspaceState = {
  workspaces: {},
  members: {},
  collections: {},
  docs: {},
};

/** Composite key for the `members` projection. */
export function memberKey(workspace_id: WorkspaceId, user_id: UserId): string {
  return `${workspace_id}::${user_id}`;
}

/**
 * One audit-log row, as the replay reducer consumes it: the persisted
 * `audit_events` envelope fields the reducer reads, plus the parsed
 * `AuditRecord` (outcome-discriminated effect).
 *
 * Defined here — not imported from `@editorzero/db`'s `AuditEventsTable`
 * — so the dependency direction stays `db → audit`. A recording
 * `AuditWriter` (in the integration property test) captures the typed
 * `AuditWriteInput` directly into this shape, so no `effect`-column JSON
 * is narrowed back to `AuditEffect` (no cast). The reducer reads:
 *   - `record` — outcome + effect (only `outcome: "allow"` mutates state).
 *   - `principal_kind` / `principal_id` — source for `created_by` on the
 *     create effects (`doc.create`, `collection.create`) whose bodies omit it.
 */
export interface ReplayRow {
  readonly principal_kind: "user" | "agent";
  readonly principal_id: string;
  readonly record: AuditRecord;
}
