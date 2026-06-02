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
 *   2. `applyStateEffect`'s `default` throws — a kind classified `"state"`
 *      with no transition fails the per-kind reducer unit test (which
 *      feeds one representative effect per `"state"` kind). So a new kind
 *      cannot land as `"state"` without a *proven* transition.
 *
 * Together: a new effect kind won't pass CI until it is both classified
 * and (if state-bearing) transitioned and proven.
 */

import type { CollectionId, DocId, WorkspaceId } from "@editorzero/ids";
import { UserId } from "@editorzero/ids";
import type { AuditEffect } from "./effect";
import {
  type CollectionState,
  type DocState,
  EMPTY_STATE,
  type MemberState,
  memberKey,
  type PersistentWorkspaceState,
  type ReplayRow,
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
  "acl.grant": "deferred",
  "acl.revoke": "deferred",
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
 */
function applyStateEffect(
  state: PersistentWorkspaceState,
  effect: AuditEffect,
  row: ReplayRow,
): PersistentWorkspaceState {
  switch (effect.kind) {
    // ── workspace ──────────────────────────────────────────────────────────
    case "workspace.create":
      return setWorkspace(state, {
        id: effect.workspace_id,
        slug: effect.slug,
        name: effect.name,
        created_by: effect.created_by,
        deleted: false,
      });
    case "workspace.update":
      // v1 reconstructs `name` only; `trash_retention_days` / `settings`
      // are excluded-by-contract (see state.ts file doc).
      return effect.patch.name !== undefined
        ? patchWorkspace(state, effect.workspace_id, { name: effect.patch.name })
        : state;
    case "workspace.soft_delete":
      return patchWorkspace(state, effect.workspace_id, { deleted: true });
    case "workspace.restore":
      return patchWorkspace(state, effect.workspace_id, { deleted: false });

    // ── members (revive-in-place collapses to the same fields: no timestamp) ──
    case "member.add":
      return setMember(state, {
        workspace_id: effect.workspace_id,
        user_id: effect.user_id,
        role: effect.role,
        deleted: false,
      });
    case "member.remove":
      return patchMember(state, effect.workspace_id, effect.user_id, { deleted: true });
    case "member.update_role":
      return patchMember(state, effect.workspace_id, effect.user_id, { role: effect.role });

    // ── collections ──────────────────────────────────────────────────────────
    case "collection.create":
      return setCollection(state, {
        id: effect.collection_id,
        workspace_id: effect.workspace_id,
        parent_id: effect.parent_id,
        title: effect.title,
        slug: effect.slug,
        order_key: effect.order_key,
        created_by: UserId(row.principal_id),
        deleted: false,
      });
    case "collection.update":
      return patchCollection(state, effect.collection_id, {
        ...(effect.patch.title !== undefined ? { title: effect.patch.title } : {}),
        ...(effect.patch.slug !== undefined ? { slug: effect.patch.slug } : {}),
        ...(effect.patch.order_key !== undefined ? { order_key: effect.patch.order_key } : {}),
      });
    case "collection.move":
      return patchCollection(state, effect.collection_id, {
        parent_id: effect.new_parent_id,
        order_key: effect.new_order_key,
      });
    case "collection.soft_delete":
      return patchCollection(state, effect.collection_id, { deleted: true });
    case "collection.restore":
      return patchCollection(state, effect.collection_id, { deleted: false });

    // ── docs ─────────────────────────────────────────────────────────────────
    case "doc.create":
      return setDoc(state, {
        id: effect.doc_id,
        workspace_id: effect.workspace_id,
        collection_id: effect.collection_id,
        title: effect.title,
        slug: effect.slug,
        order_key: effect.order_key,
        visibility: effect.visibility,
        created_by: UserId(row.principal_id),
        deleted: false,
      });
    case "doc.rename":
      return patchDoc(state, effect.doc_id, { title: effect.title });
    case "doc.move":
      return patchDoc(state, effect.doc_id, {
        collection_id: effect.new_collection_id,
        order_key: effect.new_order_key,
      });
    case "doc.publish":
      // Matches the live handler: publish flips visibility to "public".
      // `effect.published_at` is carried for the ADR 0040 Step-5 future
      // (orthogonal publish); there is no live `published_at` column yet,
      // so v1 replay does not project it.
      return patchDoc(state, effect.doc_id, { visibility: "public" });
    case "doc.unpublish":
      return patchDoc(state, effect.doc_id, { visibility: "workspace" });
    case "doc.soft_delete":
      return patchDoc(state, effect.doc_id, { deleted: true });
    case "doc.restore":
      return patchDoc(state, effect.doc_id, { deleted: false });

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
  return applyStateEffect(state, effect, row);
}

/** Replays an ordered audit log into the reconstructed projection. */
export function replay(rows: Iterable<ReplayRow>): PersistentWorkspaceState {
  let state = EMPTY_STATE;
  for (const row of rows) {
    state = applyAuditRow(state, row);
  }
  return state;
}
