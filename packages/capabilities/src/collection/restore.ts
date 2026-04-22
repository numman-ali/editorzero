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
import { NotFoundError, ParentDeletedError } from "@editorzero/errors";
import { CapabilityId, CollectionId } from "@editorzero/ids";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_RESTORE_ID = CapabilityId("collection.restore");

// ── Input ────────────────────────────────────────────────────────────────

const CollectionIdInput = z
  .uuid({ version: "v7", message: "collection_id must be a UUIDv7" })
  .transform((s): CollectionId => CollectionId(s));

const InputSchema = z
  .object({
    collection_id: CollectionIdInput,
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────

const CollectionIdField = z.string().transform((s): CollectionId => CollectionId(s));

const OutputSchema = z.object({
  collection_id: CollectionIdField,
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const collectionRestore: Capability<Input, Output> = {
  id: COLLECTION_RESTORE_ID,
  category: "mutation",
  summary:
    "Restore a soft-deleted collection; refuses if the parent collection is itself soft-deleted.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["doc:delete"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
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

    // Step 3 — restore. The `deleted_at IS NOT NULL` guard defends
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
