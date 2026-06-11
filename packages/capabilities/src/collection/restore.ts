/**
 * `collection.restore` — revive a soft-deleted collection (architecture.md
 * §3.5, ADR 0017; `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`;
 * AGENTS.md invariant 6).
 *
 * Pair of `collection.delete`. Metadata-only mutation: flips
 * `deleted_at` from non-NULL to NULL in one UPDATE. No cascade
 * semantics — descendants of a deleted collection are either still
 * live (delete refused them, slice-2 invariant) or were deleted
 * separately (restore them individually).
 *
 * **Parent-deleted precondition.** If the collection has a
 * `parent_id`, the handler SELECTs the parent and refuses with
 * `ParentDeletedError` (409, `code: "parent_deleted"`) when the
 * parent is soft-deleted. Restoring into a trashed parent would
 * create an inconsistent tree — a live child dangling under a
 * deleted folder. Pairs with `collection.delete`'s "refuse if live
 * descendants" check: together they preserve the invariant "every
 * live collection has a live path to the workspace root".
 *
 * **Parent can't be missing.** If `parent_id` points at a row that
 * was hard-deleted (outside v1; only possible via system-handle
 * writes), the SELECT returns zero rows — the handler refuses with
 * `ParentDeletedError` using the stored `parent_id`. Honest failure
 * over dangling restores.
 *
 * **Depth-cap check.** Restore is the third op (alongside
 * `collection.create` and `collection.move`) that can make a
 * collection live again, so it has to enforce the same
 * `COLLECTION_MAX_DEPTH` invariant. Slice-3 Codex review caught a
 * cross-slice gap that required this check: `collection.move` walks
 * only *live* descendants, so a sequence of "delete deep subtree
 * bottom-up → move parent deeper → restore subtree top-down" can
 * blow the cap — each restore looks cap-safe in isolation, but the
 * deepest restore lands past `MAX_DEPTH`. Running the same ancestor
 * walk + BFS subtree walk `collection.move` uses (and the same
 * strict `>=` reject rule) closes the loop. Per invariant, a
 * soft-deleted collection cannot have live descendants (since
 * `collection.delete` refuses-with-live-descendants), so the
 * subtree walk defensively returns 0 in the normal path; the walk
 * exists for correctness against future cascade-delete paths or
 * corrupt state, and the parent-depth count is the load-bearing
 * piece today.
 *
 * **Not-deleted handling.** `deleted_at IS NULL` → 404 (honest
 * projection, mirror of `doc.restore`). Restoring a live collection
 * has no defined state change; silently returning 200 would emit a
 * no-op restore audit row. Callers observing 404 on retry know the
 * collection is already live.
 *
 * **Scope.** `doc:delete`, symmetric with `collection.delete`. See
 * `doc/delete.ts` header for the "same scope, rollback must stay
 * with deleter" rationale.
 *
 * **Cascade side-effects deferred.** Same posture as
 * `collection.delete` — the handler emits the flip + audit row
 * only; search re-index / embedding re-activate / etc. land when
 * the backing systems do.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { COLLECTION_MAX_DEPTH } from "@editorzero/constants";
import { NotFoundError, ParentDeletedError, ValidationError } from "@editorzero/errors";
import { CapabilityId, type CollectionId } from "@editorzero/ids";
import {
  type CollectionRestoreInput,
  CollectionRestoreInputSchema,
  type CollectionRestoreOutput,
  CollectionRestoreOutputSchema,
} from "@editorzero/schemas/collection/restore";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_RESTORE_ID = CapabilityId("collection.restore");

// ── Capability ───────────────────────────────────────────────────────────

export const collectionRestore: Capability<CollectionRestoreInput, CollectionRestoreOutput> = {
  id: COLLECTION_RESTORE_ID,
  category: "mutation",
  summary:
    "Restore a soft-deleted collection; refuses if the parent collection is itself soft-deleted.",
  input: CollectionRestoreInputSchema,
  output: CollectionRestoreOutputSchema,
  requires: ["doc:delete"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "collection", id: input.collection_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "collection.restore",
      collection_id: output.collection_id,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: COLLECTION_RESTORE_ID,
      required_scopes: ["doc:delete"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(COLLECTION_RESTORE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 1 — fetch the deleted row to learn `parent_id`. Using a
    // SELECT over a blind UPDATE-with-RETURNING because we need the
    // `parent_id` for the parent-deleted precondition before the
    // UPDATE fires.
    const current = await ctx.db
      .selectFrom("collections")
      .select(["id", "parent_id"])
      .where("id", "=", input.collection_id)
      .where("deleted_at", "is not", null)
      .executeTakeFirst();

    if (current === undefined) {
      throw new NotFoundError({
        subject_kind: "collection",
        subject_id: input.collection_id,
      });
    }

    // Step 2 — parent-deleted precondition. Only fires when
    // `parent_id IS NOT NULL`; workspace-root restores have no parent
    // to check. A missing parent (`row === undefined`) is also a
    // refusal — see header for the dangling-restore rationale.
    if (current.parent_id !== null) {
      const parent_id: CollectionId = current.parent_id;
      const parent = await ctx.db
        .selectFrom("collections")
        .select(["id", "deleted_at"])
        .where("id", "=", parent_id)
        .executeTakeFirst();

      if (parent === undefined || parent.deleted_at !== null) {
        throw new ParentDeletedError({
          parent_kind: "collection",
          parent_id,
        });
      }
    }

    // Step 3 — depth-cap check. Closes the cross-slice gap Codex
    // flagged on slice 3: `collection.move` computes subtree_height
    // against live descendants only, so a deep-tree bottom-up delete
    // followed by a parent-move-deeper + top-down restore can push
    // the deepest restored node past `MAX_DEPTH`. The ancestor walk
    // mirrors `collection.move`'s walk exactly (load-bearing detail:
    // the depth convention and strict `>=` reject rule must match
    // `collection.create` / `collection.move` so a restore cannot
    // produce a tree either of those ops would have rejected).
    //
    // Because a live collection's ancestors are always live (the
    // `collection.delete`-refuses-with-live-descendants invariant
    // from slice 2, combined with `collection.restore`'s parent-
    // deleted precondition), the walk here is on an all-live chain —
    // no `deleted_at IS NULL` filter needed in principle. Keeping
    // the filter for defence-in-depth against future cascade-delete
    // semantics or corrupt state.
    let parent_depth = 0;
    if (current.parent_id !== null) {
      let cursor: CollectionId | null = current.parent_id;
      let iterations = 0;
      while (cursor !== null) {
        iterations += 1;
        if (iterations > COLLECTION_MAX_DEPTH) {
          throw new ValidationError({
            message: `collection.restore: ancestor chain exceeds the ${COLLECTION_MAX_DEPTH}-level cap (corrupt state)`,
            issues: [
              {
                code: "depth_cap_exceeded",
                message: `ancestor chain exceeds the ${COLLECTION_MAX_DEPTH}-level cap`,
                path: ["collection_id"],
              },
            ],
          });
        }
        const row: { parent_id: CollectionId | null } | undefined = await ctx.db
          .selectFrom("collections")
          .select(["parent_id"])
          .where("id", "=", cursor)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (row === undefined) {
          // Shouldn't happen — step 2 verified the immediate parent
          // is live, and ancestors of a live node are always live
          // (see comment above). Defensive throw so a migration gap
          // or system-handle write can't silently hide an invalid
          // restore.
          throw new ParentDeletedError({
            parent_kind: "collection",
            parent_id: cursor,
          });
        }
        cursor = row.parent_id;
      }
      parent_depth = iterations - 1;
    }

    // Step 4 — subtree-height walk. Same BFS shape as
    // `collection.move`'s walk. Per the slice-2 invariant
    // (`collection.delete` refuses-with-live-descendants →
    // `collection.create` requires a live parent → no one can
    // re-add live children under a deleted collection while it's
    // deleted), this should always return 0 in the normal path —
    // kept for defence-in-depth against future cascade-delete paths
    // or corrupt state that slipped past the write-path tx.
    let subtree_height = 0;
    {
      let frontier: CollectionId[] = [input.collection_id];
      while (frontier.length > 0) {
        const children = await ctx.db
          .selectFrom("collections")
          .select(["id"])
          .where("parent_id", "in", frontier)
          .where("deleted_at", "is", null)
          .execute();
        if (children.length === 0) break;
        subtree_height += 1;
        if (subtree_height >= COLLECTION_MAX_DEPTH) break;
        frontier = children.map((r) => r.id);
      }
    }

    // Step 5 — depth-cap reject. Root restore (parent_id === null)
    // lands at depth 0; deepest descendant = subtree_height.
    // Non-root: deepest = parent_depth + 1 + subtree_height. Strict
    // `>=` mirror of `collection.create` / `collection.move`.
    const new_deepest_depth =
      current.parent_id !== null ? parent_depth + 1 + subtree_height : subtree_height;
    if (new_deepest_depth >= COLLECTION_MAX_DEPTH) {
      throw new ValidationError({
        message: `collection.restore: restored tree depth would exceed the ${COLLECTION_MAX_DEPTH}-level cap`,
        issues: [
          {
            code: "depth_cap_exceeded",
            message: `restoring this collection would place the deepest descendant at depth ${new_deepest_depth}, but collections may be at most ${COLLECTION_MAX_DEPTH - 1} levels deep. Move the parent shallower or trim the subtree before restoring.`,
            path: ["collection_id"],
          },
        ],
      });
    }

    // Step 6 — restore. The `deleted_at IS NOT NULL` guard defends
    // against a concurrent restore between step 1 and here; zero rows
    // returned → 404.
    const row = await ctx.db
      .updateTable("collections")
      .set({ deleted_at: null, updated_at: now })
      .where("id", "=", input.collection_id)
      .where("deleted_at", "is not", null)
      .returning(["id"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({
        subject_kind: "collection",
        subject_id: input.collection_id,
      });
    }

    return {
      collection_id: row.id,
    };
  },
};
