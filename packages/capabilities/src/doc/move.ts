/**
 * `doc.move` — re-parent a doc under a different collection (or to the
 * workspace root) within the caller's workspace (architecture.md §3.5
 * / §8.4; `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`).
 *
 * Metadata-only mutation. Docs are tree leaves (no `docs.parent_id`),
 * so the move check is strictly simpler than `collection.move` — no
 * cycle walk, no subtree-height preservation.
 *
 * **Two regimes, decided by the placement buckets** (ADR 0040 §7 +
 * the Step-8 cross-boundary amendment; supersedes Step 6's blanket
 * same-bucket-only rule):
 *
 * - **Same-bucket** (legacy → legacy, same-space → same-space,
 *   including the no-op re-seat): pure navigation. Today's bar —
 *   `doc:write` + `assertCanRead`. `acl_policy` must be ABSENT
 *   (typed 400 `acl_policy_not_applicable`: accepting-and-ignoring
 *   would let the caller believe a transition happened).
 * - **Cross-boundary** (legacy ↔ space, space → other space, and the
 *   anomaly-source repair move): an explicit, audited ACL transition.
 *   Authority = `assertCanAdministerDoc` over the SOURCE placement
 *   (removing a doc from a ceiling is ACL-shaping — the same class as
 *   granting on it) + `assertCanPlaceIn(target)` (the `doc.create`
 *   standing term; Codex cross-boundary review MUST-FIX: this check is
 *   load-bearing and never waived — an owner-grant holder on an
 *   anomalous doc must NOT be able to repair it into a destination
 *   they cannot reach). `acl_policy` is REQUIRED (typed 400
 *   `acl_transition_policy_required` — the ADR's "never silent"
 *   prompt contract, enforced server-side so every surface inherits
 *   it). Both rails run AFTER the authority asserts, so a caller
 *   without administer learns nothing of placement state.
 *
 * **The two policies are clean poles.** `adopt_baseline`: the doc's
 * read set becomes exactly the destination baseline — every doc-scoped
 * grant row is hard-DELETEd, non-guest AND guest, both subject kinds
 * (Codex concurring: keeping guest edges under "adopt" would make the
 * policy name lie; a doc moving into a more private space with stale
 * crossings silently riding along is precisely the surprise the prompt
 * exists to prevent). `keep_grants`: zero ACL writes. The dropped rows
 * ride the output + effect as FULL preimages (the hard-delete-preimage
 * rule, `acl.revoke`'s posture) — one audit row total (invariant 3).
 *
 * **Anomaly placements: movable OUT, never INTO.** `doc.move` is the
 * repair verb the slice-1 anomaly MUST-FIX names ("space.restore the
 * space or doc.move the doc, then grant"). Source-anomaly crossings
 * are allowed — administer collapses to owner-tier there (creator /
 * non-guest owner grant), destination standing still required.
 * Destination anomalies refuse via `canPlaceIn` (you cannot adopt an
 * unevaluable baseline). `before_space_id` on a repair move is the
 * stored space ref when it still resolves to a (trashed) row, `null`
 * when it dangles.
 *
 * **`access_mode` rides unchanged.** The policy governs grant rows
 * only; a `private` doc stays private across the boundary (adopt on a
 * private doc leaves creator-only access until re-granted — the
 * caller chose "destination baseline" and private mode's baseline is
 * empty by definition). The mode switch is the separate reserved
 * Step-8 verb.
 *
 * Other preconditions (unchanged): 404 on missing/soft-deleted doc and
 * target collection (tenant-scoped — cross-workspace invisible);
 * target-scope sibling-slug pre-check mirroring the NULL-aware partial
 * indexes (typed 409 instead of a raw unique-violation); fresh UUIDv7
 * `order_key` re-seat; no-op same-scope moves still write (fresh
 * order_key — "move to end of same folder").
 *
 * **Scope.** `doc:write`. The cross-boundary administer requirement is
 * the resolver's, not a scope — same layering as every ACL verb.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError, SlugCollisionError, ValidationError } from "@editorzero/errors";
import { CapabilityId, type DocId, uuidV7 } from "@editorzero/ids";
import {
  type DocMoveInput,
  DocMoveInputSchema,
  type DocMoveOutput,
  DocMoveOutputSchema,
} from "@editorzero/schemas/doc/move";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_MOVE_ID = CapabilityId("doc.move");

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

export const docMove: Capability<DocMoveInput, DocMoveOutput> = {
  id: DOC_MOVE_ID,
  category: "mutation",
  summary:
    "Re-parent a doc under a different collection (or to the workspace root); cross-boundary moves are audited ACL transitions.",
  input: DocMoveInputSchema,
  output: DocMoveOutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  // "ui" landed with the doc header's Move disclosure (the doc.move ×
  // Web UI cell) — proven end-to-end by the marked Playwright spec in
  // packages/e2e (proves-capability-cell: doc.move).
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.move",
      doc_id: output.doc_id,
      new_collection_id: output.new_collection_id,
      new_order_key: output.new_order_key,
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
      capability: DOC_MOVE_ID,
      required_scopes: ["doc:write"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_MOVE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const { doc_id, new_collection_id } = input;

    // Step 1 — load the doc. 404 if missing/soft-deleted. `slug` feeds
    // the target-scope sibling-slug pre-check; `collection_id` decides
    // the placement buckets; `created_by`/`access_mode` feed the
    // resolver predicates.
    const current = await ctx.db
      .selectFrom("docs")
      .select(["id", "collection_id", "slug", "created_by", "access_mode"])
      .where("id", "=", doc_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (current === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: doc_id });
    }

    // Ceiling assert (ADR 0040 Step 6) — the caller must be able to
    // read the doc they are moving (both regimes).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanRead(current);

    // Step 2 — target collection existence (only when non-null). The
    // tenant-scoped handle makes cross-workspace targets invisible.
    if (new_collection_id !== null) {
      const target = await ctx.db
        .selectFrom("collections")
        .select(["id"])
        .where("id", "=", new_collection_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (target === undefined) {
        throw new NotFoundError({
          subject_kind: "collection",
          subject_id: new_collection_id,
        });
      }
    }

    // Step 2b — placement buckets decide the regime (file header).
    const src = acl.placementOf(current.collection_id);
    const dst = acl.placementOf(new_collection_id);
    const sameBucket =
      (src.kind === "legacy" && dst.kind === "legacy") ||
      (src.kind === "space" && dst.kind === "space" && src.space_id === dst.space_id);

    let transition: DocMoveOutput["acl_transition"];
    if (sameBucket) {
      if (input.acl_policy !== undefined) {
        throw new ValidationError({
          message:
            "doc.move: acl_policy was sent on a SAME-bucket move — no ACL transition " +
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
      // CROSSING — an audited ACL transition. Authority FIRST (a
      // caller without administer learns nothing of placement state
      // from the rails below): administer over the SOURCE placement
      // (anomaly collapses to owner-tier), then destination standing
      // (load-bearing, never waived — Codex MUST-FIX; root targets are
      // the legacy bucket, always placeable).
      acl.assertCanAdministerDoc(current);
      if (new_collection_id !== null) {
        acl.assertCanPlaceIn(new_collection_id);
      }

      if (input.acl_policy === undefined) {
        throw new ValidationError({
          message:
            "doc.move: this move crosses a space boundary — an explicit ACL " +
            "transition choice is required: acl_policy = adopt_baseline (shed every " +
            "doc-scoped grant, guest edges included) or keep_grants.",
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

      // `before_space_id` — honest about what was knowable, resolved
      // from the SAME resolver snapshot as the placement decision (no
      // read skew, no extra queries). Live source space: its id.
      // Legacy: null. Anomaly (the repair move): the stored ref when
      // it still resolves to a (trashed) spaces row, null when the
      // collection or space ref dangles.
      const before_space_id = acl.storedSpaceRefOf(current.collection_id);
      const after_space_id = dst.kind === "space" ? dst.space_id : null;

      // The policy's grant consequence. adopt_baseline hard-DELETEs
      // every doc-scoped row (both lanes, both subject kinds) with the
      // RETURNING rows as the authoritative preimages; keep_grants
      // writes nothing. Sorted by id for a deterministic payload.
      let dropped: NonNullable<DocMoveOutput["acl_transition"]>["dropped_grants"] = [];
      if (input.acl_policy === "adopt_baseline") {
        const deleted = await ctx.db
          .deleteFrom("grants")
          .where("resource_kind", "=", "doc")
          .where("resource_id", "=", doc_id)
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
    }

    // Step 3 — target-scope sibling-slug pre-check. Only runs when the
    // collection actually changes (every crossing does). NULL-aware
    // scope mirrors the partial unique indexes on `docs`.
    if (new_collection_id !== current.collection_id) {
      let collision: { id: DocId } | undefined;
      if (new_collection_id === null) {
        collision = await ctx.db
          .selectFrom("docs")
          .select(["id"])
          .where("collection_id", "is", null)
          .where("slug", "=", current.slug)
          .where("deleted_at", "is", null)
          .where("id", "!=", doc_id)
          .executeTakeFirst();
      } else {
        collision = await ctx.db
          .selectFrom("docs")
          .select(["id"])
          .where("collection_id", "=", new_collection_id)
          .where("slug", "=", current.slug)
          .where("deleted_at", "is", null)
          .where("id", "!=", doc_id)
          .executeTakeFirst();
      }
      if (collision !== undefined) {
        throw new SlugCollisionError({
          slug: current.slug,
          parent_kind: new_collection_id === null ? "workspace" : "collection",
          parent_id: new_collection_id,
        });
      }
    }

    // Step 4 — UPDATE. Fresh UUIDv7 `order_key` re-seats the doc at
    // the end of the target's sort. Defensive `deleted_at IS NULL`
    // guard against a concurrent soft-delete → 404. (The grants DELETE
    // above shares this tx — a throw here rolls the whole move back.)
    const new_order_key = uuidV7();
    const row = await ctx.db
      .updateTable("docs")
      .set({ collection_id: new_collection_id, order_key: new_order_key, updated_at: now })
      .where("id", "=", doc_id)
      .where("deleted_at", "is", null)
      .returning(["id"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: doc_id });
    }

    return {
      doc_id: row.id,
      new_collection_id,
      new_order_key,
      updated_at: now,
      ...(transition !== undefined && { acl_transition: transition }),
    };
  },
};
