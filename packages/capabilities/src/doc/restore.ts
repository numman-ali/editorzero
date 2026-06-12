/**
 * `doc.restore` — revive a soft-deleted doc (ADR 0017;
 * `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`; AGENTS.md
 * invariant 6).
 *
 * Pair of `doc.delete`. Same metadata-only lane: no `ctx.transact`, no
 * Y.Doc touching, no `doc_updates` row. Single UPDATE on the `docs`
 * row that flips `deleted_at` from non-NULL to NULL. Blocks,
 * `doc_updates`, and `doc_snapshots` are still there (ADR 0017
 * preserves them on delete), so restore is a pure liveness flip —
 * the Y.Doc is bit-identical to the pre-delete state modulo the
 * audit trail (the inverse-restore property test anchors this).
 *
 * **Scope.** `doc:delete`. Same scope as `doc.delete`. See
 * `doc/delete.ts` header for rationale; splitting delete/restore
 * across different scopes leaves docs stuck in trash when the
 * original deleter's role is revoked.
 *
 * **Parent-collection precondition (slice 2 of collections).** If the
 * doc has `collection_id IS NOT NULL`, the handler refuses with
 * `ParentDeletedError` (409, `code: "parent_deleted"`) when the parent
 * collection is itself soft-deleted (or missing, from a system-handle
 * write). Pairs with `collection.restore`'s symmetric check —
 * together they preserve the invariant "every live doc has a live path
 * to the workspace root". Callers restore the parent collection first,
 * then the doc. Handler-side (not DB-side) because `docs.collection_id`
 * has no DB-level FK yet (temporary integrity debt, tracked in slice
 * 4 notes); the query-based check works regardless.
 *
 * **Parent-SPACE precondition (ADR 0040 Step 8 slice 2, Codex review
 * MUST-FIX).** If the live parent collection is bound to a space
 * (`collections.space_id IS NOT NULL`), that space must be LIVE too —
 * otherwise restore would mint a live doc under an archived space,
 * breaking `space.archive`'s no-live-descendants invariant through
 * the inverse path. Same `ParentDeletedError` wire code
 * (`parent_deleted`), `parent_kind: "space"`. Mirrors
 * `collection.restore`'s symmetric check.
 *
 * **Not-deleted handling.** A `deleted_at IS NULL` doc returns 404.
 * Restoring a doc that isn't trashed has no defined meaning — the
 * caller already has the state they wanted; silently returning 200
 * would muddle the audit log with no-op restore rows. Callers
 * observing 404 on a restore retry know the doc is live, which is
 * what they wanted anyway. (Also: no state change means no
 * `render_version` bump, which matches the already-deleted short-
 * circuit in `doc.delete` — see the idempotency rationale there.)
 *
 * **Audit effect.** `{ kind: "doc.restore", doc_id }`. Symmetric with
 * `doc.soft_delete` — no timestamp field on the effect (the audit
 * row's own `created_at` envelope is authoritative). The capability
 * *id* stays `doc.restore`; no asymmetry here (unlike delete's
 * `doc.delete` id → `doc.soft_delete` effect split, because there's
 * no "hard restore" to disambiguate from).
 *
 * **Render-cache invalidation — `render_version` bump. The publish
 * dimension stays CLEARED (ADR 0040 Step 5):** `doc.soft_delete`
 * nulled `published_slug`/`published_at`, and restore deliberately
 * does NOT bring them back — a restored doc re-enters the workspace
 * unpublished, and re-exposure is a separate, audited `doc.publish`
 * (no surprise-republication; the old URL may have been reclaimed
 * while the doc sat in the trash).**
 * Symmetric with `doc.delete`: a restore of a *published* doc flips
 * the public-route from "404" back to "renders", which only survives
 * cache invalidation if `render_version` bumps. Same
 * `eb("render_version", "+", 1)` increment pattern
 * publish/unpublish/delete use (architecture.md §5.4).
 *
 * **Sibling-slug precondition.** The docs slug indexes are PARTIAL
 * (live rows only), so a sibling may claim a trashed doc's slug; the
 * restore UPDATE would re-enter the index domain as a raw UNIQUE
 * violation (untyped 500). Pre-check → typed `SlugCollisionError`
 * (409); rename or delete the live holder first. Same fix-forward as
 * `collection.restore`, found while deriving `space.restore` (ADR
 * 0040 Step 8 slice 2b).
 *
 * **v1 scope — `deleted_at` clear + version bump only; cascade side-
 * effects deferred.** ADR 0017 §Restore lists search-index rebuild
 * (via `restore_search` queue in `QUEUE_NAMES`), embedding re-
 * activation, and notification no-refire as the restore cascade.
 * None of those backing systems exist in the tree yet; v1 lands the
 * flip + audit emission only. Cascade jobs will enqueue off the
 * existing `outbox` row written by `withAuditTx` when the backing
 * systems land.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError, ParentDeletedError, SlugCollisionError } from "@editorzero/errors";
import { CapabilityId, type CollectionId, type DocId, type SpaceId } from "@editorzero/ids";
import {
  type DocRestoreInput,
  DocRestoreInputSchema,
  type DocRestoreOutput,
  DocRestoreOutputSchema,
} from "@editorzero/schemas/doc/restore";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_RESTORE_ID = CapabilityId("doc.restore");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocRestoreInputSchema` / `DocRestoreOutputSchema` are the single source
// (ADR 0034), reused verbatim by the API route's `validator` / `resolver`.
// Input is the `doc.delete` mirror (single UUIDv7 `doc_id`, `.strict()`);
// output carries `render_version` so the caller can swap their cached
// public-route key after a restore. The schema rationale lives in the file
// header above and at the definition in `@editorzero/schemas/doc/restore`.

// ── Capability ───────────────────────────────────────────────────────────

export const docRestore: Capability<DocRestoreInput, DocRestoreOutput> = {
  id: DOC_RESTORE_ID,
  category: "mutation",
  summary: "Restore a soft-deleted doc to its live state (inverse of doc.delete).",
  input: DocRestoreInputSchema,
  output: DocRestoreOutputSchema,
  requires: ["doc:delete"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.restore",
      doc_id: output.doc_id,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_RESTORE_ID,
      required_scopes: ["doc:delete"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_RESTORE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 1 — fetch the deleted row. We need the `collection_id` to
    // run the parent-deleted precondition before the UPDATE fires; a
    // blind UPDATE-with-RETURNING would commit the restore before we
    // could check the parent. Collection-domain slice 2 added this
    // precondition alongside `collection.restore`; docs nested under
    // a soft-deleted collection must not come back live until the
    // parent is restored first — otherwise the tree is inconsistent.
    const current = await ctx.db
      .selectFrom("docs")
      .select(["id", "collection_id", "created_by", "access_mode", "slug"])
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is not", null)
      .executeTakeFirst();

    if (current === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // Ceiling assert (ADR 0040 Step 6) — evaluated over the TRASHED
    // row's stored placement: the doc's Space binding survives the
    // trash (soft-deleted collections still bind in the resolver), so
    // who may restore is who could read it where it lived.
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanRead(current);

    // Step 2 — parent-collection precondition. Only fires when
    // `collection_id IS NOT NULL` (workspace-root docs have no parent
    // collection to check). A missing parent row (dangling
    // `collection_id` from a system-handle write or a future hard-
    // delete we don't cover in v1) also refuses — the honest
    // projection is "we can't restore this because its home is
    // gone", not silent re-parenting.
    if (current.collection_id !== null) {
      const parent_id: CollectionId = current.collection_id;
      const parent = await ctx.db
        .selectFrom("collections")
        .select(["id", "deleted_at", "space_id"])
        .where("id", "=", parent_id)
        .executeTakeFirst();

      if (parent === undefined || parent.deleted_at !== null) {
        throw new ParentDeletedError({
          parent_kind: "collection",
          parent_id,
        });
      }

      // Step 2a — parent-SPACE precondition (Step-8 slice-2 Codex
      // review MUST-FIX, mirror of `collection.restore`'s). The live
      // parent collection may be bound to an ARCHIVED space: trash the
      // doc, archive the space (`space.archive` counts live docs
      // through LIVE collections only — but also refuses on live
      // collections, so reaching here means corrupt state or a
      // restore raced an archive). Either way, restoring would mint a
      // live doc under a dead space — refuse until `space.restore`
      // runs. Same wire code (`parent_deleted`), space-flavored
      // payload.
      if (parent.space_id !== null) {
        const parentSpaceId: SpaceId = parent.space_id;
        const space = await ctx.db
          .selectFrom("spaces")
          .select(["id"])
          .where("id", "=", parentSpaceId)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (space === undefined) {
          throw new ParentDeletedError({
            parent_kind: "space",
            parent_id: parentSpaceId,
          });
        }
      }
    }

    // Step 2b — sibling-slug precondition. The docs slug indexes are
    // PARTIAL (live rows only), so a sibling may have claimed this
    // doc's slug while it sat in the trash — the restore UPDATE would
    // hit `docs_root_slug_unique`/`docs_nested_slug_unique` as a raw
    // UNIQUE violation (untyped 500). Pre-check the restore target
    // scope (NULL-aware collection, excluding self) → the same typed
    // 409 the create/rename path raises. Found while deriving
    // `space.restore`'s identical precondition (ADR 0040 Step 8
    // slice 2b); `collection.restore` gained the same check.
    let slugHolder: { id: DocId } | undefined;
    if (current.collection_id === null) {
      slugHolder = await ctx.db
        .selectFrom("docs")
        .select(["id"])
        .where("collection_id", "is", null)
        .where("slug", "=", current.slug)
        .where("id", "!=", input.doc_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
    } else {
      slugHolder = await ctx.db
        .selectFrom("docs")
        .select(["id"])
        .where("collection_id", "=", current.collection_id)
        .where("slug", "=", current.slug)
        .where("id", "!=", input.doc_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
    }
    if (slugHolder !== undefined) {
      throw new SlugCollisionError({
        slug: current.slug,
        parent_kind: current.collection_id === null ? "workspace" : "collection",
        parent_id: current.collection_id,
      });
    }

    // Step 3 — restore. Same alias-aware `WorkspaceScopingPlugin`
    // posture as delete; the `deleted_at IS NOT NULL` guard defends
    // against a concurrent restore between step 1 and here.
    const row = await ctx.db
      .updateTable("docs")
      .set((eb) => ({
        deleted_at: null,
        render_version: eb("render_version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is not", null)
      .returning(["id", "render_version"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    return {
      doc_id: row.id,
      render_version: row.render_version,
    };
  },
};
