/**
 * `collection.move` — move a collection to a tagged destination within
 * the caller's workspace (architecture.md §3.5 / §8.4;
 * `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`).
 *
 * **Destination is a tagged union (ADR 0040 space-collection crossing
 * slice)**: `{ kind: "legacy_root" }` (workspace root, no-space bucket),
 * `{ kind: "space_root", space_id }` (root level of a space), or
 * `{ kind: "collection", collection_id }` (under an existing
 * collection). The old nullable `new_parent_id` collapsed legacy root
 * and space root into one `null`; the union names each destination and
 * kills the create-style both-set rail.
 *
 * Two regimes, decided by comparing the moved row's bucket with the
 * destination's bucket (`placementOf` semantics — anomalies never
 * compare equal):
 *
 * **Same-bucket** (both legacy, or both the same live space): a
 * re-parent. `acl_policy` must be ABSENT (typed 400
 * `acl_policy_not_applicable`). Space destinations require baseline
 * reach over the bucket (`assertCanPlaceIn` on a collection
 * destination, `assertCanPlaceInSpace` on a space root);
 * legacy↔legacy stays reach-free, and an all-legacy move never loads
 * the resolver (hot path unchanged — pinned structurally by a test
 * whose driver has no space tables).
 *
 * **Crossing** (buckets differ; anomalous source always crosses): an
 * audited bulk ACL transition over EVERY doc in the moved subtree.
 * Order inside the arm (the `doc.move` precedent — authority first, so
 * a caller without authority learns nothing from the rails below):
 *
 *   1. Subtree enumeration: BFS over `parent_id` links INCLUDING
 *      soft-deleted collections, then every doc (live AND trashed)
 *      whose `collection_id` is in the subtree. Trashed rows are
 *      ACL-bearing state — restore would resurrect them inside the new
 *      bucket, so they transition now, not at restore time.
 *   2. Per-doc `assertCanAdministerDoc` over the subtree docs, sorted
 *      by `doc_id` so the first-denied doc is deterministic across
 *      drivers and replays (never DB row order). Deny names the
 *      failing doc (`acl_deny { doc_id }`). Anomalous placements
 *      collapse to owner-tier (creator / doc owner-grant) — crossing
 *      OUT of an anomaly is the repair path; crossing INTO one is
 *      impossible (`assertCanPlaceIn` fails closed).
 *   3. Destination standing, once per destination kind: `space_root` →
 *      `assertCanPlaceInSpace`; `collection` → `assertCanPlaceIn`;
 *      `legacy_root` → none (the pre-Spaces bucket is always
 *      placeable).
 *   4. `acl_policy` REQUIRED (typed 400
 *      `acl_transition_policy_required` — crossings are never silent,
 *      ADR 0040 §7): `adopt_baseline` hard-DELETEs every doc-scoped
 *      grant across the subtree (both lanes, both subject kinds, guest
 *      edges included) with RETURNING preimages sorted by `grant_id`;
 *      `keep_grants` writes zero ACL rows.
 *   5. Writes: the root row re-parents AND rebinds (`space_id` = the
 *      destination bucket's binding); every descendant (trashed
 *      included) rebinds in one UPDATE — the denormalization invariant
 *      (descendants always carry their root's binding) is maintained
 *      in the same tx. Descendant `updated_at` is NOT stamped: the
 *      mutation is the root's move; descendant rebind is
 *      denormalization maintenance, mirroring replay (the reducer's
 *      `rebindSubtreeSpace` patches `space_id` alone).
 *
 *   The transition echo (`acl_transition`: policy, before/after
 *   bindings, full dropped-grant preimages) rides the output and the
 *   ONE `collection.move` audit row — unbounded by doc count, a
 *   deliberate self-hosted-v1 posture (invariant 3 outranks row-size
 *   ceilings; a future rail would be a typed refusal by estimated
 *   preimage byte size, never a spill table). `before_space_id` is
 *   `storedSpaceRefOf` honesty: a trashed-but-resolvable ref reports
 *   itself; a dangling ref reports `null`.
 *
 * Mechanical preconditions (both regimes, `doc.move`-parallel):
 *
 *   1. **404 on missing/soft-deleted subject** (SELECT first, honest
 *      projection for both).
 *   2. **404 on missing/soft-deleted destination**: `collection` → the
 *      cycle walk doubles as the existence check; `space_root` → a
 *      live-`spaces` SELECT.
 *   3. **Cycle detection** (collection destinations): walk the target
 *      chain to the root; refuse `cycle_detected` if the moved id
 *      appears (covers direct self-parent on the first iteration).
 *   4. **Depth-cap preservation**: deepest descendant's new absolute
 *      depth must stay under `COLLECTION_MAX_DEPTH` (live-only height
 *      walk — trashed descendants re-check at restore, matching
 *      `collection.create`'s live-tree rule).
 *   5. **Target-scope sibling-slug pre-check** when the stored
 *      `parent_id` actually changes. The slug namespace is
 *      parent-scoped and space-BLIND (recorded ADR 0040 posture), so
 *      both root destinations share the NULL-parent scope; a root
 *      collection crossing buckets keeps its slot without a check. The
 *      partial unique indexes remain the race guard.
 *
 * **No-op same-parent moves** stay accepted (fresh `order_key` +
 * `updated_at` — "move to end of same folder" re-ordering semantics).
 *
 * **`order_key` re-seat**: single-replica append via fresh UUIDv7.
 *
 * **Scope.** `doc:write`, same gate as the rest of the collection
 * family.
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
import { CapabilityId, type CollectionId, type DocId, type SpaceId, uuidV7 } from "@editorzero/ids";
import {
  type CollectionMoveInput,
  CollectionMoveInputSchema,
  type CollectionMoveOutput,
  CollectionMoveOutputSchema,
} from "@editorzero/schemas/collection/move";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_MOVE_ID = CapabilityId("collection.move");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `CollectionMoveInputSchema` / `CollectionMoveOutputSchema` are the single
// source (ADR 0034), reused verbatim by the API route's `validator` /
// `resolver` so the wire contract has exactly one definition. The
// destination union's semantics (each arm `.strict()`, why the nullable
// parent id was retired) are documented at the schema definition in
// `@editorzero/schemas/collection/move`.

// `grants` preimage columns for the adopt_baseline RETURNING — mirrors
// `doc.move`'s list (the column-name truth is `GrantsTable`; `id` maps to
// the wire's `grant_id` below).
const GRANT_ROW_COLUMNS = [
  "id",
  "workspace_id",
  "resource_kind",
  "resource_id",
  "subject_kind",
  "subject_id",
  "role",
  "is_guest",
  "created_by",
  "created_at",
] as const;

// ── Capability ───────────────────────────────────────────────────────────

export const collectionMove: Capability<CollectionMoveInput, CollectionMoveOutput> = {
  id: COLLECTION_MOVE_ID,
  category: "mutation",
  summary:
    "Move a collection to a tagged destination (legacy root, space root, or another collection); " +
    "cross-bucket moves are audited bulk ACL transitions over the subtree's docs.",
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
      // Present only on a crossing — the §7 compound effect (ONE audit
      // row). The effect mirrors GrantState per dropped row (no
      // created_at — replay projections exclude timestamps); the
      // output additionally carries created_at for the caller receipt.
      ...(output.acl_transition !== undefined && {
        acl_transition: {
          policy: output.acl_transition.policy,
          before_space_id: output.acl_transition.before_space_id,
          after_space_id: output.acl_transition.after_space_id,
          dropped_grants: output.acl_transition.dropped_grants.map((g) => ({
            grant_id: g.grant_id,
            workspace_id: g.workspace_id,
            resource_kind: g.resource_kind,
            resource_id: g.resource_id,
            subject_kind: g.subject_kind,
            subject_id: g.subject_id,
            role: g.role,
            is_guest: g.is_guest,
            created_by: g.created_by,
          })),
        },
      }),
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
    const { collection_id, destination } = input;
    const new_parent_id: CollectionId | null =
      destination.kind === "collection" ? destination.collection_id : null;

    // Step 1 — load the moved collection. 404 if missing/soft-deleted.
    // `slug` feeds the target-scope sibling-slug pre-check; `parent_id`
    // detects the "no-op same-parent" case for the slug skip; the
    // STORED `space_id` feeds the bucket decision below.
    const moved = await ctx.db
      .selectFrom("collections")
      .select(["id", "parent_id", "slug", "space_id"])
      .where("id", "=", collection_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (moved === undefined) {
      throw new NotFoundError({ subject_kind: "collection", subject_id: collection_id });
    }

    // Step 2 — destination resolution.
    //
    // `collection`: cycle detection + target existence +
    // target_parent_depth in a single walk from the destination up to
    // the root. Four outputs:
    //   (a) first-iteration 404 if the destination row itself is missing
    //   (b) cycle refusal if collection_id appears anywhere in the chain
    //   (c) depth-of-new-parent = (iterations - 1)
    //   (d) the destination's STORED space ref (first iteration) — feeds
    //       the resolver-load decision in step 3.
    //
    // `space_root`: a live-`spaces` SELECT — 404 on missing/trashed
    // (existence-before-authority, the `doc.move`/`collection.create`
    // target precedent).
    //
    // `legacy_root`: nothing to resolve; target_parent_depth stays 0.
    let target_parent_depth = 0;
    let targetParentSpaceRef: SpaceId | null = null;
    if (destination.kind === "collection") {
      let cursor: CollectionId | null = destination.collection_id;
      let iterations = 0;
      while (cursor !== null) {
        if (cursor === collection_id) {
          throw new ValidationError({
            message:
              "collection.move: destination would create a cycle (target is the moved collection itself or one of its descendants)",
            issues: [
              {
                code: "cycle_detected",
                message: "a collection cannot be moved under itself or any of its descendants",
                path: ["destination", "collection_id"],
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
                path: ["destination", "collection_id"],
              },
            ],
          });
        }
        const row: { parent_id: CollectionId | null; space_id: SpaceId | null } | undefined =
          await ctx.db
            .selectFrom("collections")
            .select(["parent_id", "space_id"])
            .where("id", "=", cursor)
            .where("deleted_at", "is", null)
            .executeTakeFirst();
        if (row === undefined) {
          throw new NotFoundError({ subject_kind: "collection", subject_id: cursor });
        }
        if (cursor === destination.collection_id) targetParentSpaceRef = row.space_id;
        cursor = row.parent_id;
      }
      target_parent_depth = iterations - 1;
    } else if (destination.kind === "space_root") {
      const space = await ctx.db
        .selectFrom("spaces")
        .select(["id"])
        .where("id", "=", destination.space_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (space === undefined) {
        throw new NotFoundError({ subject_kind: "space", subject_id: destination.space_id });
      }
    }

    // Step 3 — bucket decision + regime split (file header). The
    // resolver loads ONLY when some space machinery is actually in
    // play: the moved row carries a stored ref, the destination names a
    // space, or the destination collection carries a stored ref. An
    // all-legacy move (every stored ref null, root or legacy-collection
    // destination) is same-bucket by definition — no resolver, no extra
    // queries (pinned structurally by a test whose driver has no space
    // tables). A null stored ref IS legacy (`placementOf` on a null ref
    // cannot be an anomaly), so the fast path can't mask one.
    const needResolver =
      moved.space_id !== null ||
      destination.kind === "space_root" ||
      (destination.kind === "collection" && targetParentSpaceRef !== null);

    let transition: CollectionMoveOutput["acl_transition"];
    // The post-move binding for the whole subtree; same-bucket moves
    // never change it.
    let new_space_id: SpaceId | null = moved.space_id;

    if (!needResolver) {
      // Legacy → legacy. Same-bucket: the policy field must be absent
      // (zod cannot see stored placement, so the rail lives here even
      // on the resolver-free path).
      if (input.acl_policy !== undefined) {
        throw new ValidationError({
          message:
            "collection.move: acl_policy was sent on a SAME-bucket move — no ACL transition " +
            "occurs within one ceiling bucket; drop the field.",
          issues: [
            {
              code: "acl_policy_not_applicable",
              message:
                "this move does not cross a space boundary; accepting the policy " +
                "would promise an ACL change that does not happen",
              path: ["acl_policy"],
            },
          ],
        });
      }
    } else {
      const acl = await loadDocReadResolver(ctx.db, ctx.principal);
      const src = acl.placementOf(collection_id);
      // The destination bucket, by destination kind. `space_root`
      // liveness was already 404-checked against the row, so the
      // binding is the named space; `collection` resolves through
      // `placementOf` (trashed/dangling refs collapse to `anomaly` and
      // fail closed — crossing INTO an anomaly dies on
      // `assertCanPlaceIn` below).
      const dst =
        destination.kind === "legacy_root"
          ? ({ kind: "legacy" } as const)
          : destination.kind === "space_root"
            ? ({ kind: "space", space_id: destination.space_id } as const)
            : acl.placementOf(destination.collection_id);
      const sameBucket =
        (src.kind === "legacy" && dst.kind === "legacy") ||
        (src.kind === "space" && dst.kind === "space" && src.space_id === dst.space_id);

      if (sameBucket) {
        if (input.acl_policy !== undefined) {
          throw new ValidationError({
            message:
              "collection.move: acl_policy was sent on a SAME-bucket move — no ACL transition " +
              "occurs within one ceiling bucket; drop the field.",
            issues: [
              {
                code: "acl_policy_not_applicable",
                message:
                  "this move does not cross a space boundary; accepting the policy " +
                  "would promise an ACL change that does not happen",
                path: ["acl_policy"],
              },
            ],
          });
        }
        // Same-space re-parents require baseline reach over the bucket
        // (the `collection.create` placement term). Same-bucket +
        // space implies a space destination: either the destination
        // collection (graft/restructure) or the space's own root.
        if (destination.kind === "collection" && dst.kind === "space") {
          acl.assertCanPlaceIn(destination.collection_id);
        } else if (destination.kind === "space_root") {
          acl.assertCanPlaceInSpace(destination.space_id);
        }
      } else {
        // CROSSING — an audited bulk ACL transition (file header).
        //
        // Subtree enumeration first (it feeds the authority pass):
        // collections via BFS over parent links INCLUDING soft-deleted
        // rows (trashed state is ACL-bearing — restore would resurrect
        // it inside the new bucket). The seen-set guards a corrupt
        // cyclic chain; unlike the depth walk there is no level cap —
        // a silent break would silently SKIP docs from the transition.
        const subtreeIds: CollectionId[] = [collection_id];
        const seen = new Set<CollectionId>([collection_id]);
        let frontier: CollectionId[] = [collection_id];
        while (frontier.length > 0) {
          const children = await ctx.db
            .selectFrom("collections")
            .select(["id"])
            .where("parent_id", "in", frontier)
            .execute();
          const fresh = children.map((r) => r.id).filter((id) => !seen.has(id));
          for (const id of fresh) {
            seen.add(id);
            subtreeIds.push(id);
          }
          frontier = fresh;
        }

        // Every doc in the subtree, live AND trashed — each carries the
        // resolver-predicate columns (`CeilingDocRow`).
        const subtreeDocs = await ctx.db
          .selectFrom("docs")
          .select(["id", "collection_id", "created_by", "access_mode"])
          .where("collection_id", "in", subtreeIds)
          .execute();

        // Authority — per-doc administer, sorted by doc_id so the
        // first-denied doc is deterministic across drivers and replays
        // (never DB row order; Codex review). Deny names the failing
        // doc (`acl_deny { doc_id }`). Atomic refuse: the throw rolls
        // back the whole move (nothing has been written yet).
        const sortedDocs = [...subtreeDocs].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        for (const doc of sortedDocs) {
          acl.assertCanAdministerDoc(doc);
        }

        // Destination standing — once per destination kind
        // (load-bearing, never waived; legacy root is the pre-Spaces
        // bucket, always placeable).
        if (destination.kind === "space_root") {
          acl.assertCanPlaceInSpace(destination.space_id);
        } else if (destination.kind === "collection") {
          acl.assertCanPlaceIn(destination.collection_id);
        }

        if (input.acl_policy === undefined) {
          throw new ValidationError({
            message:
              "collection.move: this move crosses a space boundary — an explicit ACL " +
              "transition choice is required for the subtree's docs: acl_policy = " +
              "adopt_baseline (shed every doc-scoped grant, guest edges included) or keep_grants.",
            issues: [
              {
                code: "acl_transition_policy_required",
                message:
                  "cross-boundary moves are never silent (ADR 0040 §7); send " +
                  "acl_policy to choose the transition",
                path: ["acl_policy"],
              },
            ],
          });
        }

        // `before_space_id` — honest about what was knowable, from the
        // SAME resolver snapshot as the placement decision. Live source
        // space: its id. Legacy: null. Anomaly (the repair move): the
        // stored ref when it still resolves to a (trashed) spaces row,
        // null when the ref dangles.
        const before_space_id = acl.storedSpaceRefOf(collection_id);
        const after_space_id = dst.kind === "space" ? dst.space_id : null;
        new_space_id = after_space_id;

        // The policy's grant consequence over the WHOLE subtree.
        // adopt_baseline hard-DELETEs every doc-scoped row (both lanes,
        // both subject kinds) with RETURNING preimages, sorted by
        // grant_id for a deterministic payload; keep_grants writes
        // nothing.
        let dropped: NonNullable<CollectionMoveOutput["acl_transition"]>["dropped_grants"] = [];
        if (input.acl_policy === "adopt_baseline" && subtreeDocs.length > 0) {
          const docIds: DocId[] = subtreeDocs.map((d) => d.id);
          const deleted = await ctx.db
            .deleteFrom("grants")
            .where("resource_kind", "=", "doc")
            .where("resource_id", "in", docIds)
            .returning(GRANT_ROW_COLUMNS)
            .execute();
          dropped = deleted
            .map((row) => ({
              grant_id: row.id,
              workspace_id: row.workspace_id,
              resource_kind: row.resource_kind,
              resource_id: row.resource_id,
              subject_kind: row.subject_kind,
              subject_id: row.subject_id,
              role: row.role,
              is_guest: row.is_guest,
              created_by: row.created_by,
              created_at: row.created_at,
            }))
            .sort((a, b) => (a.grant_id < b.grant_id ? -1 : a.grant_id > b.grant_id ? 1 : 0));
        }

        transition = {
          policy: input.acl_policy,
          before_space_id,
          after_space_id,
          dropped_grants: dropped,
        };

        // Descendant rebind (root rebinds in the step-6 UPDATE). One
        // UPDATE over the rest of the subtree, trashed rows included —
        // the denormalization invariant holds in the same tx. No
        // `updated_at` stamp (header: denormalization maintenance, not
        // a per-row mutation; mirrors the reducer's
        // `rebindSubtreeSpace`).
        const descendants = subtreeIds.filter((id) => id !== collection_id);
        if (descendants.length > 0) {
          await ctx.db
            .updateTable("collections")
            .set({ space_id: after_space_id })
            .where("id", "in", descendants)
            .execute();
        }
      }
    }

    // Step 4 — subtree-height walk (max descendant depth relative to the
    // moved node). BFS level-by-level over LIVE rows (trashed descendants
    // re-check the cap at restore, matching `collection.create`'s
    // live-tree rule). Upper-bounded by the cap-defensive break.
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

    // Step 5 — depth-cap check. Matches `collection.create`'s rule
    // (`new_depth >= COLLECTION_MAX_DEPTH` → throw), extended to the
    // deepest descendant after the move. Root destinations simplify to
    // `subtree_height >= COLLECTION_MAX_DEPTH` (target_parent_depth = 0
    // and there is no `+1` for the moved-node step).
    const new_deepest_depth =
      destination.kind === "collection" ? target_parent_depth + 1 + subtree_height : subtree_height;
    if (new_deepest_depth >= COLLECTION_MAX_DEPTH) {
      throw new ValidationError({
        message: `collection.move: resulting tree depth would exceed the ${COLLECTION_MAX_DEPTH}-level cap`,
        issues: [
          {
            code: "depth_cap_exceeded",
            message: `moving under this parent would place the deepest descendant at depth ${new_deepest_depth}, but collections may be at most ${COLLECTION_MAX_DEPTH - 1} levels deep`,
            path: ["destination"],
          },
        ],
      });
    }

    // Step 6 — target-scope sibling-slug pre-check. Only runs when the
    // stored parent actually changes (a no-op same-parent move can't
    // collide; a root collection crossing buckets keeps its NULL-parent
    // slot — the slug namespace is parent-scoped and space-BLIND).
    // NULL-aware scope mirrors the partial unique indexes. Excludes
    // self defensively.
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

    // Step 7 — UPDATE the root row. Fresh UUIDv7 `order_key` places the
    // moved item at the end of the target's single-replica append
    // order; on a crossing the SAME statement rebinds the root
    // (`space_id`), so root + descendants land in one tx with the
    // grants DELETE — a throw anywhere rolls the whole move back. The
    // `deleted_at IS NULL` WHERE guard is defensive against a
    // concurrent soft-delete between step 1 and here; zero rows
    // returned → 404.
    const new_order_key = uuidV7();
    const row = await ctx.db
      .updateTable("collections")
      .set({
        parent_id: new_parent_id,
        order_key: new_order_key,
        updated_at: now,
        space_id: new_space_id,
      })
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
      new_space_id,
      updated_at: now,
      ...(transition !== undefined && { acl_transition: transition }),
    };
  },
};
