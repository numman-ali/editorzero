/**
 * `collection.delete` — soft-delete a collection with live-descendants
 * refusal (architecture.md §3.5, ADR 0017; `METADATA_ONLY_CAPABILITIES`
 * in `@editorzero/scopes`; AGENTS.md invariant 6).
 *
 * Metadata-only mutation: flips `collections.deleted_at` from NULL to
 * `ctx.now()` in a single UPDATE. No cascading delete of child
 * collections or docs — v1 requires the caller to empty the collection
 * first.
 *
 * **Why refuse on live descendants, not cascade.** ADR 0017 anchors
 * soft-delete on recoverable 1:1 state — restore must bring the subject
 * back bit-identical modulo audit. Cascading a delete across the
 * sub-tree would force cascading restore (is that a tree-walk at
 * restore time? a cascade flag on the deleted rows? both break the 1:1
 * inverse). Refusing is simpler and matches the UX pairing with
 * `collection.restore`'s parent-deleted check: empty the folder before
 * deleting it. The descendants-count payload in `HasLiveDescendantsError`
 * lets clients render a specific "3 docs + 1 subfolder still here"
 * error without a follow-up list call.
 *
 * **Descendants scope — direct children only.** The pre-check counts
 * `collections.parent_id = this.id` and `docs.collection_id = this.id`
 * (both `deleted_at IS NULL`). Grandchild collections / docs are not
 * counted directly — they are transitively blocked by their parent
 * collection still being live (you can't delete grandfather without
 * first deleting the sub-tree bottom-up, at which point each level's
 * descendants go to zero). Walking the whole subtree in the pre-check
 * would be O(depth × children) SELECTs for a refusal we can surface
 * with a single two-COUNT query.
 *
 * **Already-deleted handling.** Same policy as `doc.delete` (honest
 * projection): `deleted_at IS NOT NULL` → 404. Re-deleting would slide
 * the 30-day recovery window, which ADR 0017 anchors on the first
 * `deleted_at`.
 *
 * **Scope.** `doc:delete`, same gate as `doc.delete` / `doc.restore`.
 * Symmetric pair with `collection.restore` — who can delete must
 * retain the rollback.
 *
 * **No `render_version` bump.** Unlike `doc.delete`, collections
 * don't back a public-route projection — there is no cached render
 * keyed on a collection to invalidate. The column simply doesn't
 * exist on `collections`.
 *
 * **Cascade side-effects deferred.** ADR 0017 lists search re-index /
 * notification cancel / etc. as the cascade; none of those backing
 * systems exist yet. The v1 handler emits the flip + audit row only.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { HasLiveDescendantsError, NotFoundError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type CollectionDeleteInput,
  CollectionDeleteInputSchema,
  type CollectionDeleteOutput,
  CollectionDeleteOutputSchema,
} from "@editorzero/schemas/collection/delete";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_DELETE_ID = CapabilityId("collection.delete");

// ── Capability ───────────────────────────────────────────────────────────

export const collectionDelete: Capability<CollectionDeleteInput, CollectionDeleteOutput> = {
  id: COLLECTION_DELETE_ID,
  category: "mutation",
  summary:
    "Soft-delete a collection; refuses if live descendants remain. Reversible via collection.restore.",
  input: CollectionDeleteInputSchema,
  output: CollectionDeleteOutputSchema,
  requires: ["doc:delete"],
  agentAllowed: {},
  // "ui" landed with the /collection/$collectionId detail screen's
  // morph-confirm Trash action (the collection.delete × Web UI cell) —
  // proven end-to-end by the marked Playwright spec in packages/e2e
  // (proves-capability-cell: collection.delete).
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "collection", id: input.collection_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "collection.soft_delete",
      collection_id: output.collection_id,
      deleted_at: output.deleted_at,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: COLLECTION_DELETE_ID,
      required_scopes: ["doc:delete"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(COLLECTION_DELETE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 1 — existence / liveness check. A blind UPDATE with
    // `deleted_at IS NULL` would conflate "missing" with "already
    // deleted"; we want both to 404 but the descendant check only
    // runs when the row is live, so we SELECT first.
    const current = await ctx.db
      .selectFrom("collections")
      .select(["id"])
      .where("id", "=", input.collection_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (current === undefined) {
      throw new NotFoundError({
        subject_kind: "collection",
        subject_id: input.collection_id,
      });
    }

    // Step 2 — direct-child descendants check. Two COUNT(*) queries
    // against the tenant-scoped handle; parallelised via
    // `Promise.all` because they hit independent tables and the
    // second doesn't depend on the first. Using `count(*)` via a
    // `select` builder keeps the Kysely type signal; the cast
    // follows the project's `count` idiom (sqlite returns strings
    // on some bindings, postgres returns bigint — `Number(...)`
    // normalises both).
    const [childCollections, childDocs] = await Promise.all([
      ctx.db
        .selectFrom("collections")
        .where("parent_id", "=", input.collection_id)
        .where("deleted_at", "is", null)
        .select((eb) => eb.fn.countAll<string | number | bigint>().as("count"))
        .executeTakeFirstOrThrow(),
      ctx.db
        .selectFrom("docs")
        .where("collection_id", "=", input.collection_id)
        .where("deleted_at", "is", null)
        .select((eb) => eb.fn.countAll<string | number | bigint>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);

    const collections = Number(childCollections.count);
    const docs = Number(childDocs.count);

    if (collections > 0 || docs > 0) {
      throw new HasLiveDescendantsError({
        collection_id: input.collection_id,
        descendant_counts: { collections, docs },
      });
    }

    // Step 3 — soft-delete. The `deleted_at IS NULL` guard is defensive
    // against a concurrent delete between step 1 and here; zero rows
    // returned → 404 (honest projection, same rationale as doc.delete).
    const row = await ctx.db
      .updateTable("collections")
      .set({ deleted_at: now, updated_at: now })
      .where("id", "=", input.collection_id)
      .where("deleted_at", "is", null)
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
      deleted_at: now,
    };
  },
};
