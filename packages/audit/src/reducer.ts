/**
 * The audit-replay reducer — invariant 3a's engine.
 *
 * `replay(rows)` folds `audit_events` rows (in `created_at` order) into a
 * `PersistentWorkspaceState` (`./state.ts`). Invariant 3a holds when that
 * reconstruction deep-equals the same projection built from the live DB —
 * proven in `../prop/replay.prop.ts` against the *real* dispatcher.
 *
 * ── The effect→state contract ────────────────────────────────────────────
 *
 * Every one of the `AuditEffect` kinds is classified in `REPLAY_CLASS`
 * below. The classification is the reviewable contract; the four classes
 * are mutually exclusive and total:
 *
 *   - `"state"`     — mutates the metadata projection. Has a transition
 *                     in `applyStateEffect`.
 *   - `"content"`   — mutates the block / CRDT projection (invariant 3b),
 *                     NOT the metadata spine. No-op for this reducer; the
 *                     documented 3a/3b boundary.
 *   - `"audit-only"`— never mutates durable domain state by nature (reads,
 *                     admin operational actions). No-op, forever.
 *   - `"deferred"`  — durable state, but NO shipped capability emits it
 *                     yet (the full-model kinds: comments, attachments,
 *                     acls, agents, tokens, mirror, domains, webhooks,
 *                     purge). No-op *today*; when its capability ships it
 *                     is reclassified to `"state"` (or `"content"`) and
 *                     given a transition + property coverage. This is the
 *                     class that keeps today's behavior from silently
 *                     ossifying: a future kind cannot masquerade as an
 *                     intentional no-op.
 *
 * ── The forcing function (compile-time, stronger than a lint) ─────────────
 *
 *   1. `REPLAY_CLASS satisfies Record<AuditEffect["kind"], ReplayClass>` —
 *      a new `AuditEffect` variant fails to compile until it is classified.
 *   2. A new `"state"` kind must also gain a representative fixture: the
 *      reducer unit test's `STATE_KIND_FIXTURES` is itself
 *      `satisfies Record<StateKind, …>` (compile error otherwise), and it
 *      drives every fixture through the reducer. A kind that is classified
 *      `"state"` and fixtured but has no transition hits
 *      `applyStateEffect`'s `default` throw — a red test, not a silent gap.
 *
 * Together: a new effect kind won't pass CI until it is classified, and (if
 * `"state"`) fixtured and transitioned — the missing transition surfaces as a
 * failing assertion, never a quiet no-op.
 */

import type { CollectionId, DocId, GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AuditEffect } from "./effect";
import {
  type CollectionState,
  type DocState,
  EMPTY_STATE,
  type GrantState,
  type MemberState,
  memberKey,
  type PersistentWorkspaceState,
  type ReplayRow,
  type SpaceMemberState,
  type SpaceState,
  spaceMemberKey,
  type WorkspaceState,
} from "./state";

export type ReplayClass = "state" | "content" | "audit-only" | "deferred";

/**
 * The classification SSOT for every `AuditEffect` kind. `satisfies` makes
 * a missing or unknown kind a compile error — this is the contract a
 * reviewer reads and the gate a new kind must pass through.
 */
export const REPLAY_CLASS = {
  // ── audit-only: reads + operational admin actions (never durable state) ──
  "audit.access_log": "audit-only",
  "admin.reembed_workspace": "audit-only",
  "admin.reindex_workspace": "audit-only",
  "admin.evict_doc": "audit-only",
  "admin.unlock_doc": "audit-only",
  "admin.job_requeue": "audit-only",
  "admin.job_cancel": "audit-only",
  "admin.queue_pause": "audit-only",
  "admin.queue_resume": "audit-only",
  "admin.secret_rotate": "audit-only",
  "admin.diagnose": "audit-only",

  // ── state: the metadata spine (shipped-capability transitions) ───────────
  "workspace.create": "state",
  "workspace.update": "state",
  "workspace.soft_delete": "state",
  "workspace.restore": "state",
  "member.add": "state",
  "member.remove": "state",
  "member.update_role": "state",
  "space.create": "state",
  "space.update": "state",
  "space.archive": "state",
  "space.restore": "state",
  "space.member_add": "state",
  "space.member_remove": "state",
  "space.member_update_role": "state",
  "acl.grant": "state",
  "acl.revoke": "state",
  "collection.create": "state",
  "collection.update": "state",
  "collection.move": "state",
  "collection.soft_delete": "state",
  "collection.restore": "state",
  "doc.create": "state",
  "doc.rename": "state",
  "doc.move": "state",
  "doc.publish": "state",
  "doc.unpublish": "state",
  "doc.soft_delete": "state",
  "doc.restore": "state",

  // ── content: block / CRDT projection (invariant 3b boundary) ─────────────
  "doc.reconcile_base_token": "content",
  "block.insert": "content",
  "block.update": "content",
  "block.remove": "content",
  "block.set_visibility": "content",
  "doc.update_batch": "content",
  "version.create": "content",
  "version.restore": "content",

  // ── deferred: durable, but no shipped capability emits it yet ────────────
  "workspace.purge": "deferred",
  "doc.purge": "deferred",
  "comment.create": "deferred",
  "comment.update": "deferred",
  "comment.resolve": "deferred",
  "comment.soft_delete": "deferred",
  "attachment.request_upload": "deferred",
  "attachment.confirm_upload": "deferred",
  "attachment.soft_delete": "deferred",
  "agent.create": "deferred",
  "agent.rename": "deferred",
  "agent.revoke": "deferred",
  "token.create": "deferred",
  "token.revoke": "deferred",
  "mirror.configure": "deferred",
  "mirror.enable": "deferred",
  "mirror.disable": "deferred",
  "mirror.reset_state": "deferred",
  "mirror.reset_auth": "deferred",
  "custom_domain.add": "deferred",
  "custom_domain.verify": "deferred",
  "custom_domain.remove": "deferred",
  "webhook.created": "deferred",
  "webhook.updated": "deferred",
  "webhook.deleted": "deferred",
  "webhook.rotated": "deferred",
  "webhook.circuit_broken": "deferred",
  "webhook.test_delivery": "deferred",
} as const satisfies Record<AuditEffect["kind"], ReplayClass>;

// ── Immutable projection helpers ───────────────────────────────────────────

function setWorkspace(s: PersistentWorkspaceState, w: WorkspaceState): PersistentWorkspaceState {
  return { ...s, workspaces: { ...s.workspaces, [w.id]: w } };
}

function patchWorkspace(
  s: PersistentWorkspaceState,
  id: WorkspaceId,
  patch: Partial<WorkspaceState>,
): PersistentWorkspaceState {
  const cur = s.workspaces[id];
  return cur ? setWorkspace(s, { ...cur, ...patch }) : s;
}

function setMember(s: PersistentWorkspaceState, m: MemberState): PersistentWorkspaceState {
  return { ...s, members: { ...s.members, [memberKey(m.workspace_id, m.user_id)]: m } };
}

function patchMember(
  s: PersistentWorkspaceState,
  ws: WorkspaceId,
  user: UserId,
  patch: Partial<MemberState>,
): PersistentWorkspaceState {
  const cur = s.members[memberKey(ws, user)];
  return cur ? setMember(s, { ...cur, ...patch }) : s;
}

function setCollection(s: PersistentWorkspaceState, c: CollectionState): PersistentWorkspaceState {
  return { ...s, collections: { ...s.collections, [c.id]: c } };
}

function patchCollection(
  s: PersistentWorkspaceState,
  id: CollectionId,
  patch: Partial<CollectionState>,
): PersistentWorkspaceState {
  const cur = s.collections[id];
  return cur ? setCollection(s, { ...cur, ...patch }) : s;
}

/**
 * Stamp `space_id` on every collection in `root_id`'s subtree (the root
 * included). The denormalization invariant — a descendant always
 * carries its root's binding — makes `collection.move`'s single
 * `new_space_id` sufficient post-state for the whole subtree; this walk
 * is the reducer-side half of that contract (BFS over the projection's
 * own parent links, so replay needs no extra effect payload).
 */
function rebindSubtreeSpace(
  s: PersistentWorkspaceState,
  root_id: CollectionId,
  space_id: SpaceId | null,
): PersistentWorkspaceState {
  const all = Object.values(s.collections);
  const subtree = new Set<string>([root_id]);
  let frontier: readonly string[] = [root_id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const c of all) {
      if (c.parent_id !== null && frontier.includes(c.parent_id) && !subtree.has(c.id)) {
        subtree.add(c.id);
        next.push(c.id);
      }
    }
    frontier = next;
  }
  const collections = { ...s.collections };
  for (const id of subtree) {
    const cur = collections[id];
    if (cur) collections[id] = { ...cur, space_id };
  }
  return { ...s, collections };
}

function setSpace(s: PersistentWorkspaceState, sp: SpaceState): PersistentWorkspaceState {
  return { ...s, spaces: { ...s.spaces, [sp.id]: sp } };
}

function patchSpace(
  s: PersistentWorkspaceState,
  id: SpaceId,
  patch: Partial<SpaceState>,
): PersistentWorkspaceState {
  const cur = s.spaces[id];
  return cur ? setSpace(s, { ...cur, ...patch }) : s;
}

function setSpaceMember(
  s: PersistentWorkspaceState,
  m: SpaceMemberState,
): PersistentWorkspaceState {
  return {
    ...s,
    space_members: { ...s.space_members, [spaceMemberKey(m.space_id, m.user_id)]: m },
  };
}

function patchSpaceMember(
  s: PersistentWorkspaceState,
  space_id: SpaceId,
  user_id: UserId,
  patch: Partial<SpaceMemberState>,
): PersistentWorkspaceState {
  const cur = s.space_members[spaceMemberKey(space_id, user_id)];
  return cur ? setSpaceMember(s, { ...cur, ...patch }) : s;
}

/** Hard-DELETE projection: removing the key IS the post-state (Step-4 DDL). */
function removeSpaceMember(
  s: PersistentWorkspaceState,
  space_id: SpaceId,
  user_id: UserId,
): PersistentWorkspaceState {
  const key = spaceMemberKey(space_id, user_id);
  if (!(key in s.space_members)) return s;
  const { [key]: _removed, ...rest } = s.space_members;
  return { ...s, space_members: rest };
}

function setGrant(s: PersistentWorkspaceState, g: GrantState): PersistentWorkspaceState {
  return { ...s, grants: { ...s.grants, [g.id]: g } };
}

/** Grants are hard-DELETE too (H1): revoke removes the key. */
function removeGrant(s: PersistentWorkspaceState, id: GrantId): PersistentWorkspaceState {
  if (!(id in s.grants)) return s;
  const { [id]: _removed, ...rest } = s.grants;
  return { ...s, grants: rest };
}

function setDoc(s: PersistentWorkspaceState, d: DocState): PersistentWorkspaceState {
  return { ...s, docs: { ...s.docs, [d.id]: d } };
}

function patchDoc(
  s: PersistentWorkspaceState,
  id: DocId,
  patch: Partial<DocState>,
): PersistentWorkspaceState {
  const cur = s.docs[id];
  return cur ? setDoc(s, { ...cur, ...patch }) : s;
}

/**
 * Applies one `"state"`-classed effect. Reached only via `applyAuditRow`'s
 * `REPLAY_CLASS` gate, so the `default` branch fires exactly when a kind is
 * classified `"state"` without a transition — the per-kind unit test makes
 * that a failing test, not a silent gap.
 *
 * Purely effect-driven: every projected field reads from `effect`, never
 * from the audit-row envelope (`created_by` comes from the effect body, not
 * `principal_id` — Codex review HIGH 1).
 */
function applyStateEffect(
  state: PersistentWorkspaceState,
  effect: AuditEffect,
): PersistentWorkspaceState {
  switch (effect.kind) {
    // ── workspace ──────────────────────────────────────────────────────────
    case "workspace.create":
      return setWorkspace(state, {
        id: effect.workspace_id,
        slug: effect.slug,
        name: effect.name,
        trash_retention_days: effect.trash_retention_days,
        settings: effect.settings,
        created_by: effect.created_by,
        deleted_at: null,
      });
    case "workspace.update":
      // Apply every field the patch carries — name, retention, settings.
      // (Codex review HIGH 3: the projection previously reconstructed `name`
      // only, dropping retention / settings mutations on the floor.)
      return patchWorkspace(state, effect.workspace_id, {
        ...(effect.patch.name !== undefined ? { name: effect.patch.name } : {}),
        ...(effect.patch.trash_retention_days !== undefined
          ? { trash_retention_days: effect.patch.trash_retention_days }
          : {}),
        ...(effect.patch.settings !== undefined ? { settings: effect.patch.settings } : {}),
      });
    case "workspace.soft_delete":
      return patchWorkspace(state, effect.workspace_id, { deleted_at: effect.deleted_at });
    case "workspace.restore":
      return patchWorkspace(state, effect.workspace_id, { deleted_at: null });

    // ── members (revive-in-place resets deleted_at to null) ──────────────────
    case "member.add":
      return setMember(state, {
        workspace_id: effect.workspace_id,
        user_id: effect.user_id,
        role: effect.role,
        deleted_at: null,
      });
    case "member.remove":
      return patchMember(state, effect.workspace_id, effect.user_id, {
        deleted_at: effect.deleted_at,
      });
    case "member.update_role":
      return patchMember(state, effect.workspace_id, effect.user_id, { role: effect.role });

    // ── spaces (ADR 0040 Step 7) ─────────────────────────────────────────────
    case "space.create":
      // `space_kind`/`space_type` map back to the row columns `kind`/`type`
      // (the effect renames them because `kind` is the union discriminant).
      return setSpace(state, {
        id: effect.space_id,
        workspace_id: effect.workspace_id,
        kind: effect.space_kind,
        type: effect.space_type,
        owner_user_id: effect.owner_user_id,
        name: effect.name,
        slug: effect.slug,
        baseline_access: effect.baseline_access,
        created_by: effect.created_by,
        deleted_at: null,
      });
    case "space.update":
      return patchSpace(state, effect.space_id, {
        ...(effect.patch.name !== undefined ? { name: effect.patch.name } : {}),
        ...(effect.patch.slug !== undefined ? { slug: effect.patch.slug } : {}),
        ...(effect.patch.space_type !== undefined ? { type: effect.patch.space_type } : {}),
        ...(effect.patch.baseline_access !== undefined
          ? { baseline_access: effect.patch.baseline_access }
          : {}),
      });
    case "space.archive":
      return patchSpace(state, effect.space_id, { deleted_at: effect.deleted_at });
    case "space.restore":
      return patchSpace(state, effect.space_id, { deleted_at: null });

    // ── space members (hard-DELETE: remove nets the key away) ───────────────
    case "space.member_add":
      return setSpaceMember(state, {
        workspace_id: effect.workspace_id,
        space_id: effect.space_id,
        user_id: effect.user_id,
        role: effect.role,
      });
    case "space.member_remove":
      return removeSpaceMember(state, effect.space_id, effect.user_id);
    case "space.member_update_role":
      return patchSpaceMember(state, effect.space_id, effect.user_id, { role: effect.role });

    // ── grants (hard-DELETE: grant-then-revoke nets to no entry — H1) ───────
    case "acl.grant":
      return setGrant(state, {
        id: effect.grant_id,
        workspace_id: effect.workspace_id,
        resource_kind: effect.resource_kind,
        resource_id: effect.resource_id,
        subject_kind: effect.subject_kind,
        subject_id: effect.subject_id,
        role: effect.role,
        is_guest: effect.is_guest,
        created_by: effect.created_by,
      });
    case "acl.revoke":
      return removeGrant(state, effect.grant_id);

    // ── collections ──────────────────────────────────────────────────────────
    case "collection.create":
      return setCollection(state, {
        id: effect.collection_id,
        workspace_id: effect.workspace_id,
        parent_id: effect.parent_id,
        space_id: effect.space_id,
        title: effect.title,
        slug: effect.slug,
        order_key: effect.order_key,
        created_by: effect.created_by,
        deleted_at: null,
      });
    case "collection.update":
      return patchCollection(state, effect.collection_id, {
        ...(effect.patch.title !== undefined ? { title: effect.patch.title } : {}),
        ...(effect.patch.slug !== undefined ? { slug: effect.patch.slug } : {}),
        ...(effect.patch.order_key !== undefined ? { order_key: effect.patch.order_key } : {}),
      });
    case "collection.move":
      // Re-parent first, then stamp the post-move binding across the
      // subtree (root included) — `new_space_id` is sufficient for all
      // descendants by the denormalization invariant (see the helper).
      return rebindSubtreeSpace(
        patchCollection(state, effect.collection_id, {
          parent_id: effect.new_parent_id,
          order_key: effect.new_order_key,
        }),
        effect.collection_id,
        effect.new_space_id,
      );
    case "collection.soft_delete":
      return patchCollection(state, effect.collection_id, { deleted_at: effect.deleted_at });
    case "collection.restore":
      return patchCollection(state, effect.collection_id, { deleted_at: null });

    // ── docs ─────────────────────────────────────────────────────────────────
    case "doc.create":
      return setDoc(state, {
        id: effect.doc_id,
        workspace_id: effect.workspace_id,
        collection_id: effect.collection_id,
        title: effect.title,
        slug: effect.slug,
        order_key: effect.order_key,
        access_mode: effect.access_mode,
        // A doc is never born published (ADR 0040 Step 5).
        published_slug: null,
        published_at: null,
        created_by: effect.created_by,
        deleted_at: null,
      });
    case "doc.rename":
      // Both fields move together: the handler slugifies the new title and
      // writes title + slug in one UPDATE, so replay applies both (parallel to
      // `collection.update`). Projecting `title` alone left a stale slug.
      return patchDoc(state, effect.doc_id, { title: effect.title, slug: effect.slug });
    case "doc.move": {
      const moved = patchDoc(state, effect.doc_id, {
        collection_id: effect.new_collection_id,
        order_key: effect.new_order_key,
      });
      // Cross-boundary move (ADR 0040 §7): under `adopt_baseline` the
      // handler hard-deleted the listed doc grants in the same write;
      // replay removes exactly those keys (the preimage fields are
      // forensic — removal is by id, the acl.revoke posture). Absent /
      // empty = no-op (every same-bucket move, and `keep_grants`
      // crossings).
      const dropped = effect.acl_transition?.dropped_grants ?? [];
      return dropped.reduce((s, grant) => removeGrant(s, grant.grant_id), moved);
    }
    case "doc.publish":
      // Both values come from the effect (ADR 0040 Step 5): the slug is
      // handler-COMPUTED (collision-suffixed), so replay must carry it —
      // never re-derive; on idempotent re-publish the handler echoes the
      // doc's existing pair, so replay converges on the same state.
      return patchDoc(state, effect.doc_id, {
        published_slug: effect.published_slug,
        published_at: effect.published_at,
      });
    case "doc.unpublish":
      return patchDoc(state, effect.doc_id, { published_slug: null, published_at: null });
    case "doc.soft_delete":
      // Soft-delete also clears the publish dimension (the live handler
      // does — a trashed doc leaves the public site; restore must never
      // surprise-republish). Unconditional, so no effect payload needed.
      return patchDoc(state, effect.doc_id, {
        deleted_at: effect.deleted_at,
        published_slug: null,
        published_at: null,
      });
    case "doc.restore":
      return patchDoc(state, effect.doc_id, { deleted_at: null });

    default:
      /* v8 ignore start -- @preserve defensive: applyAuditRow's REPLAY_CLASS
         gate routes only "state"-classed kinds here, so this is reached only
         if a kind is classified "state" without a transition — which the
         per-kind reducer unit test turns into a red test, not a silent gap. */
      throw new Error(
        `replay: effect kind "${effect.kind}" is classified "state" in REPLAY_CLASS ` +
          `but has no transition — add one (and a per-kind fixture) or reclassify.`,
      );
    /* v8 ignore stop */
  }
}

/**
 * Folds one audit row into the projection. Deny/error rows and every
 * non-`"state"` effect class are no-ops.
 */
export function applyAuditRow(
  state: PersistentWorkspaceState,
  row: ReplayRow,
): PersistentWorkspaceState {
  const { record } = row;
  if (record.outcome !== "allow") return state;
  const { effect } = record;
  if (REPLAY_CLASS[effect.kind] !== "state") return state;
  return applyStateEffect(state, effect);
}

/** Replays an ordered audit log into the reconstructed projection. */
export function replay(rows: Iterable<ReplayRow>): PersistentWorkspaceState {
  let state = EMPTY_STATE;
  for (const row of rows) {
    state = applyAuditRow(state, row);
  }
  return state;
}
