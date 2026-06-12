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
 * reducer folds the audit **row** (envelope + effect — see `ReplayRow`) and
 * is *purely effect-driven*: every projected field reads from the effect
 * body, never from the envelope principal. (`created_by` used to reconstruct
 * from `principal_id`; that was wrong for an agent write — the effect now
 * carries the handler-resolved human attribution. Codex review HIGH 1.) The
 * boundary list below *is* the honesty surface of invariant 3a — what
 * reconstructs, what doesn't, and why — so it is enumerated here rather than
 * left implicit:
 *
 *  1. **`created_at` / `updated_at` are NOT reconstructable — by construction.**
 *       The handler stamps the entity row via `ctx.now()`; the audit writer
 *       stamps the audit row via its own `now()` — *different ticks* — and the
 *       create effect bodies carry neither. So the audit log cannot reproduce
 *       those exact values; the projection drops them.
 *
 *       `deleted_at` is the exception (Codex review HIGH 4): the soft-delete
 *       handlers RETURN the exact `ctx.now()` they wrote to the row, the
 *       `*.soft_delete` / `member.remove` effects now CARRY that value, and the
 *       reducer projects it verbatim — so `deleted_at` reconstructs precisely
 *       (the handler's clock, not the audit row's), preserving the ADR 0017
 *       recovery-window anchor across replay. `restore` resets it to `null`;
 *       `create` / `member.add` start it at `null`.
 *
 *  2. **Server-minted secrets — never audit-derived, by design.**
 *     - `workspaces.diagnostic_salt` (16 random bytes, F64). Not domain
 *       state; replaying the log must NOT reproduce a secret.
 *
 *  3. **`trash_retention_days` / `settings` ARE reconstructed (Codex review HIGH 3).**
 *       `workspace.create` carries both (no longer DDL-default guesses) and
 *       `workspace.update` carries them in its patch, so an admin who changes
 *       retention or settings is reflected in the projection. `settings` is
 *       the parsed object (the form `workspace.get` exposes), not the stored
 *       JSON string.
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
 * of *genesis* state, not audit-reconstructable. The resolution (Codex
 * review HIGH 2) is to EMIT `workspace.create` + `member.add` from the
 * bootstrap under an audited `workspace.bootstrap` system-mutation marker —
 * closing invariant 3 for signup — rather than seed replay with genesis.
 * That lands in its own slice; until it does, a replay over a freshly-
 * signed-up workspace will not contain the root workspace / owner rows.
 *
 * **The `docs` read-scope field is the ADR 0040 Step-5 seam.** Today it is
 * the live overloaded `visibility ∈ {workspace, public, private}` column;
 * Step 5 splits it into `access_mode ∈ {space, private}` + `published_at`.
 * The reducer sets this field in exactly two places (`doc.create` initial,
 * `doc.publish`/`doc.unpublish` flip), so the split lands as an additive
 * transform — not a reducer rewrite. The property compares this field
 * against whatever the live `docs` columns are, so it tracks the schema.
 */

import type { CollectionId, DocId, GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import type { GrantRole, SpaceKind, SpaceType } from "@editorzero/scopes";

import type { AuditRecord, DocVisibility, Role } from "./types";

/** Reconstructed `workspaces` projection (excludes salt + create/update timestamps). */
export interface WorkspaceState {
  readonly id: WorkspaceId;
  readonly slug: string;
  readonly name: string;
  readonly trash_retention_days: number;
  /** Parsed settings object (the form `workspace.get` exposes), not the stored JSON string. */
  readonly settings: Record<string, unknown>;
  readonly created_by: UserId;
  /** Epoch-ms the workspace was soft-deleted, or `null` if live (ADR 0017 recovery anchor). */
  readonly deleted_at: number | null;
}

/** Reconstructed `workspace_members` projection. */
export interface MemberState {
  readonly workspace_id: WorkspaceId;
  readonly user_id: UserId;
  readonly role: Role;
  /** Epoch-ms the membership was soft-deleted, or `null` if live. */
  readonly deleted_at: number | null;
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
  /** Epoch-ms the collection was soft-deleted, or `null` if live (ADR 0017). */
  readonly deleted_at: number | null;
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
  /** Epoch-ms the doc was soft-deleted, or `null` if live (ADR 0017 recovery anchor). */
  readonly deleted_at: number | null;
}

/**
 * Reconstructed `spaces` projection (ADR 0040 Step 4). The table landed
 * ahead of its effects: no `space.*` effect kind exists yet (Step 7),
 * so until then a correct replay yields an EMPTY map — and the live
 * table is provably empty too (no capability writes it before Step 8).
 * Carrying the key now keeps the §9.1 tuple lockstep with the schema,
 * which is the Step-4 mandate.
 */
export interface SpaceState {
  readonly id: SpaceId;
  readonly workspace_id: WorkspaceId;
  readonly kind: SpaceKind;
  readonly type: SpaceType;
  readonly owner_user_id: UserId | null;
  readonly name: string;
  readonly slug: string;
  readonly baseline_access: GrantRole;
  readonly created_by: UserId;
  /** Epoch-ms the space was soft-deleted, or `null` if live. */
  readonly deleted_at: number | null;
}

/** Reconstructed `space_members` projection (ADR 0040 Step 4 — see SpaceState). */
export interface SpaceMemberState {
  readonly workspace_id: WorkspaceId;
  readonly space_id: SpaceId;
  readonly user_id: UserId;
  readonly role: GrantRole;
}

/**
 * Reconstructed `grants` projection (ADR 0040 Step 4 — see SpaceState).
 * Hard-DELETE lifecycle: a revoke REMOVES the key (forward-replay of
 * grant-then-revoke nets to no entry — H1), so there is no deleted_at.
 */
export interface GrantState {
  readonly id: GrantId;
  readonly workspace_id: WorkspaceId;
  readonly resource_kind: "space" | "doc";
  readonly resource_id: string;
  readonly subject_kind: "user" | "agent";
  readonly subject_id: string;
  readonly role: GrantRole;
  readonly is_guest: 0 | 1;
  readonly created_by: UserId;
}

/**
 * The reconstructed projection. Entities are keyed by id (members by a
 * `${workspace_id}::${user_id}` composite, space members by
 * `${space_id}::${user_id}`) so equality is order-independent — a
 * deep-equal against the same projection built from the live DB is the
 * invariant-3a assertion.
 *
 * `collections` does NOT yet project `space_id` (the column landed in
 * Step 4): no effect can set it until the Step-7 effect family, and a
 * projected column no effect carries would fail replay the moment a
 * fixture touched it. The field joins this projection IN THE SAME
 * COMMIT as the effect that mutates it (the Step-7 lockstep rule).
 */
export interface PersistentWorkspaceState {
  readonly workspaces: Readonly<Record<string, WorkspaceState>>;
  readonly members: Readonly<Record<string, MemberState>>;
  readonly collections: Readonly<Record<string, CollectionState>>;
  readonly docs: Readonly<Record<string, DocState>>;
  readonly spaces: Readonly<Record<string, SpaceState>>;
  readonly space_members: Readonly<Record<string, SpaceMemberState>>;
  readonly grants: Readonly<Record<string, GrantState>>;
}

/** The starting point for a replay — an empty workspace universe. */
export const EMPTY_STATE: PersistentWorkspaceState = {
  workspaces: {},
  members: {},
  collections: {},
  docs: {},
  spaces: {},
  space_members: {},
  grants: {},
};

/** Composite key for the `members` projection. */
export function memberKey(workspace_id: WorkspaceId, user_id: UserId): string {
  return `${workspace_id}::${user_id}`;
}

/** Composite key for the `space_members` projection (ADR 0040). */
export function spaceMemberKey(space_id: SpaceId, user_id: UserId): string {
  return `${space_id}::${user_id}`;
}

/**
 * One audit-log row, as the replay reducer consumes it: the persisted
 * `audit_events` envelope fields plus the parsed `AuditRecord`
 * (outcome-discriminated effect).
 *
 * Defined here — not imported from `@editorzero/db`'s `AuditEventsTable`
 * — so the dependency direction stays `db → audit`. A recording
 * `AuditWriter` (in the integration property test) captures the typed
 * `AuditWriteInput` directly into this shape, so no `effect`-column JSON
 * is narrowed back to `AuditEffect` (no cast).
 *
 * State reconstruction reads ONLY `record` (outcome + effect; only
 * `outcome: "allow"` mutates state). `principal_kind` / `principal_id` are
 * the forensic envelope fields (who acted) — the reducer no longer reads
 * them, since `created_by` now comes from the effect body, not the envelope
 * (Codex review HIGH 1). They stay on the row because it models a real
 * `audit_events` row and the integration property captures them.
 */
export interface ReplayRow {
  readonly principal_kind: "user" | "agent";
  readonly principal_id: string;
  readonly record: AuditRecord;
}
