/**
 * `doc.move` — re-parent a doc under a different collection (or to the
 * workspace root) within the caller's workspace (architecture.md §3.5
 * / §8.4; `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`).
 *
 * Metadata-only mutation: single UPDATE on `docs.collection_id` +
 * `order_key` + `updated_at`. Docs are tree leaves (no
 * `docs.parent_id`), so the move check is strictly simpler than
 * `collection.move` — no cycle walk, no subtree-height preservation.
 *
 * Preconditions the handler enforces:
 *
 *   1. **404 on missing/soft-deleted doc.** SELECT the target row
 *      (`deleted_at IS NULL`) first; same honest projection as the
 *      other `doc.*` mutations.
 *   2. **404 on missing/soft-deleted target collection.** When
 *      `new_collection_id !== null`, SELECT the target collection
 *      with the tenant-scoped handle. Cross-workspace targets are
 *      invisible to the plugin, so they surface as 404 too — no
 *      leakage of existence across workspace boundaries.
 *   3. **Target-scope slug collision pre-check.** The
 *      `(workspace_id, collection_id, slug)` partial unique indexes
 *      are NULL-aware (root: `collection_id IS NULL`; nested:
 *      `collection_id IS NOT NULL`); the pre-check mirrors the shape
 *      to surface `SlugCollisionError` as a typed 409 on the common
 *      path rather than letting the partial index bubble as
 *      `internal`. Runs only when the collection actually changes
 *      (same-scope moves can't collide because the doc already holds
 *      that slug uniquely).
 *
 * **No-op same-scope moves.** `new_collection_id === current.collection_id`
 * is accepted and still writes (fresh `order_key` + `updated_at`) —
 * Notion-like "move to end of same folder".
 *
 * **`order_key` re-seat.** Fresh UUIDv7 places the moved doc at the
 * end of the target's single-replica append order. See
 * `doc.create` / `collection.move` for the multi-replica future.
 *
 * **Scope.** `doc:write`, same gate as `doc.rename` / `doc.update`.
 * Members can re-parent their own writable docs; guests cannot.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError, SlugCollisionError } from "@editorzero/errors";
import { CapabilityId, type DocId, uuidV7 } from "@editorzero/ids";
import {
  type DocMoveInput,
  DocMoveInputSchema,
  type DocMoveOutput,
  DocMoveOutputSchema,
} from "@editorzero/schemas/doc/move";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_MOVE_ID = CapabilityId("doc.move");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocMoveInputSchema` / `DocMoveOutputSchema` are the single source
// (ADR 0034), defined in `@editorzero/schemas/doc/move` and reused
// verbatim by the API route's `validator` / `resolver`. `z.input` is
// the wire shape (plain strings); each field's `.transform()` narrows
// to the branded internal shape — `DocMoveInput` / `DocMoveOutput`.
// `new_collection_id` is `.nullable()` (not `.optional()`): a move is
// explicit, so `null` (workspace root) is distinct from "missing".

// ── Capability ───────────────────────────────────────────────────────────

export const docMove: Capability<DocMoveInput, DocMoveOutput> = {
  id: DOC_MOVE_ID,
  category: "mutation",
  summary:
    "Re-parent a doc under a different collection (or to the workspace root); metadata-only.",
  input: DocMoveInputSchema,
  output: DocMoveOutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.move",
      doc_id: output.doc_id,
      new_collection_id: output.new_collection_id,
      new_order_key: output.new_order_key,
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

    // Step 1 — load the doc. 404 if missing/soft-deleted. `slug` is
    // needed for the target-scope sibling-slug pre-check;
    // `collection_id` is needed to detect the no-op same-scope case.
    const current = await ctx.db
      .selectFrom("docs")
      .select(["id", "collection_id", "slug"])
      .where("id", "=", doc_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (current === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: doc_id });
    }

    // Step 2 — target collection existence (only when non-null). The
    // tenant-scoped handle makes cross-workspace targets invisible,
    // matching the same cross-workspace 404 posture as `doc.create`'s
    // collection check.
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

    // Step 3 — target-scope sibling-slug pre-check. Only runs when the
    // collection actually changes. NULL-aware scope mirrors the
    // partial unique indexes on `docs`. Excludes self defensively.
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
    // guard against a concurrent soft-delete → 404.
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
    };
  },
};
