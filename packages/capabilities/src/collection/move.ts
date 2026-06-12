/**
 * `collection.move` — re-parent a collection under a different collection
 * (or to the workspace root) within the caller's workspace
 * (architecture.md §3.5 / §8.4; `METADATA_ONLY_CAPABILITIES` in
 * `@editorzero/scopes`).
 *
 * Shape: single UPDATE on `collections.parent_id` + `order_key` +
 * `updated_at`. Metadata-only (no Y.Doc / `doc_updates` interaction).
 *
 * Preconditions the handler enforces before the UPDATE:
 *
 *   1. **404 on missing/soft-deleted subject.** SELECT the moved row
 *      (`deleted_at IS NULL`) first; honest projection for both
 *      "doesn't exist" and "soft-deleted".
 *   2. **404 on missing/soft-deleted target parent.** If
 *      `new_parent_id !== null`, the cycle-detection walk (step 3)
 *      doubles as the target-exists check — a missing row surfaces as
 *      404 with the caller-supplied id.
 *   3. **Cycle detection.** Walk the target-parent chain to the root.
 *      Refuse with `ValidationError` + issue code `cycle_detected` if
 *      the moved collection's id appears anywhere in the chain. This
 *      includes `new_parent_id === collection_id` (direct self-parent)
 *      — caught on the walk's first iteration.
 *   4. **Subtree-height preservation.** Compute the max descendant
 *      depth of the moved subtree (BFS level-by-level); the deepest
 *      descendant's new absolute depth is
 *      `target_parent_depth + 1 + subtree_height` (or
 *      `subtree_height` when `new_parent_id === null`). Refuse with
 *      `depth_cap_exceeded` if that reaches `COLLECTION_MAX_DEPTH`.
 *      The strict `>=` matches `collection.create`'s rule exactly so a
 *      move cannot produce a tree `collection.create` would have
 *      rejected. Subtree walk is O(tree size) SELECTs (one per
 *      descendant level); acceptable at the 8-level cap. A defensive
 *      `break` at `subtree_height >= COLLECTION_MAX_DEPTH` guards
 *      against corrupt state that would otherwise walk forever.
 *   5. **Target-scope slug collision pre-check.** When the parent
 *      actually changes, slug uniqueness is scoped to the *new*
 *      parent (the partial unique indexes key on
 *      `(workspace_id, parent_id, slug)` with two variants for
 *      NULL-aware root vs nested). Throws `SlugCollisionError`
 *      (409, `code: "slug_collision"`) on hit. The DB-side partial
 *      unique indexes remain the last-line guard for the
 *      pre-check → UPDATE race window.
 *
 * **No-op same-parent moves.** `new_parent_id === current.parent_id`
 * is accepted and still writes (fresh `order_key` + `updated_at`).
 * The Notion-like read is "move to end of same folder" — callers
 * explicitly requesting a move to the current parent get re-ordering
 * semantics.
 *
 * **`order_key` re-seat.** Single-replica append: a fresh UUIDv7
 * places the moved item at the end of the target's sort order.
 * Multi-replica / fractional-index ordering lands with the
 * projection-blocks job (architecture.md §3.5 / §16.9).
 *
 * **Scope.** `doc:write`, same gate as `collection.create` /
 * `collection.update`.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { COLLECTION_MAX_DEPTH } from "@editorzero/constants";
import { NotFoundError, SlugCollisionError, ValidationError } from "@editorzero/errors";
import { CapabilityId, type CollectionId, uuidV7 } from "@editorzero/ids";
import {
  type CollectionMoveInput,
  CollectionMoveInputSchema,
  type CollectionMoveOutput,
  CollectionMoveOutputSchema,
} from "@editorzero/schemas/collection/move";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_MOVE_ID = CapabilityId("collection.move");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `CollectionMoveInputSchema` / `CollectionMoveOutputSchema` are the single
// source (ADR 0034), reused verbatim by the API route's `validator` /
// `resolver` so the wire contract has exactly one definition. The
// capability semantics that shape these (`.strict()` rejecting unknown
// keys, `new_parent_id` being `.nullable()` but not `.optional()` so an
// omitted field is a 400 rather than a silent no-op) are documented in the
// file header above and at the schema definition in
// `@editorzero/schemas/collection/move`.

// ── Capability ───────────────────────────────────────────────────────────

export const collectionMove: Capability<CollectionMoveInput, CollectionMoveOutput> = {
  id: COLLECTION_MOVE_ID,
  category: "mutation",
  summary:
    "Re-parent a collection within the workspace; cycle-free + depth-cap-preserving + target-scope slug check.",
  input: CollectionMoveInputSchema,
  output: CollectionMoveOutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "collection", id: input.collection_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "collection.move",
      collection_id: output.collection_id,
      new_parent_id: output.new_parent_id,
      new_order_key: output.new_order_key,
      new_space_id: output.new_space_id,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: COLLECTION_MOVE_ID,
      required_scopes: ["doc:write"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(COLLECTION_MOVE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const { collection_id, new_parent_id } = input;

    // Step 1 — load the moved collection. 404 if missing/soft-deleted.
    // `slug` is needed for the target-scope sibling-slug pre-check;
    // `parent_id` is needed to detect the "no-op same-parent" case for
    // the slug skip.
    // `space_id` rides along so the output + audit effect can echo the
    // post-move binding (the handler never rewrites it — ADR 0040
    // Step 7; the Step-8 placement slice owns cross-space rebinds).
    const moved = await ctx.db
      .selectFrom("collections")
      .select(["id", "parent_id", "slug", "space_id"])
      .where("id", "=", collection_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (moved === undefined) {
      throw new NotFoundError({ subject_kind: "collection", subject_id: collection_id });
    }

    // Step 2 — cycle detection + target existence + target_parent_depth.
    // Single walk from new_parent_id up to the root. Three outputs:
    //
    //   (a) first-iteration 404 if the target row itself is missing
    //   (b) cycle refusal if collection_id appears anywhere in the chain
    //   (c) depth-of-new-parent = (iterations - 1)
    //       because iteration 1 is the parent itself (root has depth 0
    //       in our convention, matching collection.create).
    //
    // When `new_parent_id === null` we skip the walk; target_parent_depth
    // stays 0 (the caller is moving to the workspace root).
    let target_parent_depth = 0;
    if (new_parent_id !== null) {
      let cursor: CollectionId | null = new_parent_id;
      let iterations = 0;
      while (cursor !== null) {
        if (cursor === collection_id) {
          throw new ValidationError({
            message:
              "collection.move: new_parent_id would create a cycle (target is the moved collection itself or one of its descendants)",
            issues: [
              {
                code: "cycle_detected",
                message: "a collection cannot be moved under itself or any of its descendants",
                path: ["new_parent_id"],
              },
            ],
          });
        }
        iterations += 1;
        // Defensive: cap the ancestor walk at MAX_DEPTH + 1. The tree
        // invariant says no chain should exceed that; if a concurrent
        // write or corrupt state produced one, we fail closed rather
        // than walk forever.
        if (iterations > COLLECTION_MAX_DEPTH) {
          throw new ValidationError({
            message: `collection.move: ancestor chain exceeds the ${COLLECTION_MAX_DEPTH}-level cap (corrupt state)`,
            issues: [
              {
                code: "depth_cap_exceeded",
                message: `ancestor chain exceeds the ${COLLECTION_MAX_DEPTH}-level cap`,
                path: ["new_parent_id"],
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
          throw new NotFoundError({ subject_kind: "collection", subject_id: cursor });
        }
        cursor = row.parent_id;
      }
      target_parent_depth = iterations - 1;
    }

    // Step 3 — subtree-height walk (max descendant depth relative to the
    // moved node). BFS level-by-level: at each step query the children
    // of the current frontier. `subtree_height` counts the levels below
    // the moved node (moved alone = 0, moved with direct children = 1,
    // ...). Upper-bounded by the cap-defensive break.
    let subtree_height = 0;
    {
      let frontier: CollectionId[] = [collection_id];
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

    // Step 4 — depth-cap check. Matches `collection.create`'s rule
    // (`new_depth >= COLLECTION_MAX_DEPTH` → throw), extended to the
    // deepest descendant after the move. Root-case simplifies to
    // `subtree_height >= COLLECTION_MAX_DEPTH` (new_parent_depth = 0 and
    // there is no `+1` for the moved-node step).
    const new_deepest_depth =
      new_parent_id !== null ? target_parent_depth + 1 + subtree_height : subtree_height;
    if (new_deepest_depth >= COLLECTION_MAX_DEPTH) {
      throw new ValidationError({
        message: `collection.move: resulting tree depth would exceed the ${COLLECTION_MAX_DEPTH}-level cap`,
        issues: [
          {
            code: "depth_cap_exceeded",
            message: `moving under this parent would place the deepest descendant at depth ${new_deepest_depth}, but collections may be at most ${COLLECTION_MAX_DEPTH - 1} levels deep`,
            path: ["new_parent_id"],
          },
        ],
      });
    }

    // Step 5 — target-scope sibling-slug pre-check. Only runs when the
    // parent actually changes (a no-op same-parent move can't collide
    // because the row is already the unique holder of that slug in
    // that scope). NULL-aware parent scope mirrors the partial unique
    // indexes. Excludes self defensively.
    if (new_parent_id !== moved.parent_id) {
      let collision: { id: CollectionId } | undefined;
      if (new_parent_id === null) {
        collision = await ctx.db
          .selectFrom("collections")
          .select(["id"])
          .where("parent_id", "is", null)
          .where("slug", "=", moved.slug)
          .where("deleted_at", "is", null)
          .where("id", "!=", collection_id)
          .executeTakeFirst();
      } else {
        collision = await ctx.db
          .selectFrom("collections")
          .select(["id"])
          .where("parent_id", "=", new_parent_id)
          .where("slug", "=", moved.slug)
          .where("deleted_at", "is", null)
          .where("id", "!=", collection_id)
          .executeTakeFirst();
      }
      if (collision !== undefined) {
        throw new SlugCollisionError({
          slug: moved.slug,
          parent_kind: new_parent_id === null ? "workspace" : "collection",
          parent_id: new_parent_id,
        });
      }
    }

    // Step 6 — UPDATE. Fresh UUIDv7 `order_key` places the moved item
    // at the end of the target's single-replica append order. The
    // `deleted_at IS NULL` WHERE guard is defensive against a
    // concurrent soft-delete between step 1 and here; zero rows
    // returned → 404.
    const new_order_key = uuidV7();
    const row = await ctx.db
      .updateTable("collections")
      .set({ parent_id: new_parent_id, order_key: new_order_key, updated_at: now })
      .where("id", "=", collection_id)
      .where("deleted_at", "is", null)
      .returning(["id"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "collection", subject_id: collection_id });
    }

    return {
      collection_id: row.id,
      new_parent_id,
      new_order_key,
      new_space_id: moved.space_id,
      updated_at: now,
    };
  },
};
