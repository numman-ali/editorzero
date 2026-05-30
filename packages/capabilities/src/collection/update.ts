/**
 * `collection.update` — rename a collection (architecture.md §3.5 / §8.4,
 * ADR 0017; `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`).
 *
 * v1 mutable surface is `title` only; slug is derived from title via
 * `slugify` (mirror of `collection.create`). Other `collections`
 * columns are either immutable (`id`, `workspace_id`, `created_by`,
 * `created_at`), owned by a separate capability (`parent_id` →
 * `collection.move`, slice 3), or write-path-managed (`updated_at`,
 * `deleted_at`, `order_key`). Naming this `.update` (not `.rename`)
 * keeps room for future additive fields without a capability shuffle.
 *
 * **Metadata-only.** No `ctx.transact`, no Y.Doc touching, no
 * `doc_updates` row — same lane as `collection.create` / `collection.list`.
 * Single UPDATE on the `collections` row; the dispatcher's write-path
 * tx wraps it with the audit row.
 *
 * **Slug collision — handler pre-check.** The partial unique indexes on
 * `(workspace_id, parent_id, slug) WHERE deleted_at IS NULL` (two, for
 * NULL-aware uniqueness) would catch a collision as a SQL UNIQUE
 * violation, but that would audit as `internal`. The handler runs a
 * SELECT pre-check against the same sibling scope and throws
 * `SlugCollisionError` (409, `code: "slug_collision"`) on hit — typed
 * 409 on the common path, same as the pattern in `collection.create`'s
 * retrofit (slice 2). The race window (pre-check → UPDATE) is still
 * guarded by the DB index; a concurrent sibling insert with the same
 * slug will bubble as `internal` (rare).
 *
 * **404 semantics.** A missing or soft-deleted row surfaces as
 * `NotFoundError` (same as `doc.rename`). Updating a trashed collection
 * has no defined meaning — callers use `collection.restore` first.
 *
 * **Scope.** `doc:write`, same gate as `collection.create`. Members /
 * admins / owners hold it; guests don't.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError, SlugCollisionError } from "@editorzero/errors";
import { CapabilityId, type CollectionId } from "@editorzero/ids";
import {
  type CollectionUpdateInput,
  CollectionUpdateInputSchema,
  type CollectionUpdateOutput,
  CollectionUpdateOutputSchema,
} from "@editorzero/schemas/collection/update";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_UPDATE_ID = CapabilityId("collection.update");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `CollectionUpdateInputSchema` / `CollectionUpdateOutputSchema` are the
// single source (ADR 0034), reused verbatim by the API route's `validator`
// / `resolver`. `z.input` is the wire shape (plain strings); each field's
// `.transform()` narrows to the branded internal shape
// (`CollectionUpdateInput` / `CollectionUpdateOutput`). The shapes that
// drive these (`.strict()` rejecting unknown keys, the trim-then-`min(1)`
// title rule, `slug` tracking `title`) are documented in the file header
// above and at the schema definition in
// `@editorzero/schemas/collection/update`.

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Mirror of `collection.create`'s `slugify` — kept duplicated (not
 * imported) so rename-side slug derivation stays visibly coupled to
 * the create-side one. A future "stable slug on rename" policy would
 * diverge here without a shared-helper refactor.
 */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "untitled";
}

// ── Capability ───────────────────────────────────────────────────────────

export const collectionUpdate: Capability<CollectionUpdateInput, CollectionUpdateOutput> = {
  id: COLLECTION_UPDATE_ID,
  category: "mutation",
  summary: "Rename a collection (title → slug); metadata-only (no CRDT touch).",
  input: CollectionUpdateInputSchema,
  output: CollectionUpdateOutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "collection", id: input.collection_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "collection.update",
      collection_id: output.collection_id,
      // v1 always writes both title and slug (slug tracks title — see
      // header). When a future slice adds reorder the handler will
      // emit `{ order_key }` instead / additionally.
      patch: { title: output.title, slug: output.slug },
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: COLLECTION_UPDATE_ID,
      required_scopes: ["doc:write"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(COLLECTION_UPDATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const title = input.title;
    const slug = slugify(title);

    // Step 1 — fetch the current row to (a) 404 on missing/soft-deleted
    // and (b) learn `parent_id` for the sibling-slug scope. One extra
    // round-trip vs a blind UPDATE, but needed to classify the 404
    // before the slug check and to build a specific `SlugCollisionError`.
    const current = await ctx.db
      .selectFrom("collections")
      .select(["id", "parent_id", "slug"])
      .where("id", "=", input.collection_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (current === undefined) {
      throw new NotFoundError({
        subject_kind: "collection",
        subject_id: input.collection_id,
      });
    }

    // Step 2 — sibling-slug pre-check when the slug is actually
    // changing. Self-matches are filtered by `id != input.collection_id`
    // so a no-op rename (same title → same slug) doesn't spuriously
    // collide with itself. NULL-aware parent scope matches the partial
    // unique indexes' shape.
    if (slug !== current.slug) {
      let collision: { id: CollectionId } | undefined;
      if (current.parent_id === null) {
        collision = await ctx.db
          .selectFrom("collections")
          .select(["id"])
          .where("parent_id", "is", null)
          .where("slug", "=", slug)
          .where("deleted_at", "is", null)
          .where("id", "!=", input.collection_id)
          .executeTakeFirst();
      } else {
        collision = await ctx.db
          .selectFrom("collections")
          .select(["id"])
          .where("parent_id", "=", current.parent_id)
          .where("slug", "=", slug)
          .where("deleted_at", "is", null)
          .where("id", "!=", input.collection_id)
          .executeTakeFirst();
      }
      if (collision !== undefined) {
        throw new SlugCollisionError({
          slug,
          parent_kind: current.parent_id === null ? "workspace" : "collection",
          parent_id: current.parent_id,
        });
      }
    }

    // Step 3 — UPDATE. RETURNING is used to echo the post-state without
    // a follow-up SELECT; the WorkspaceScopingPlugin auto-scopes the
    // predicate so cross-workspace targets remain invisible (the earlier
    // SELECT would have already 404'd those).
    const row = await ctx.db
      .updateTable("collections")
      .set({ title, slug, updated_at: now })
      .where("id", "=", input.collection_id)
      .where("deleted_at", "is", null)
      .returning(["id", "title", "slug", "updated_at"])
      .executeTakeFirst();

    if (row === undefined) {
      // Defensive: the SELECT above succeeded but the UPDATE returned
      // zero rows — means the row was soft-deleted concurrently. Honest
      // projection is 404.
      throw new NotFoundError({
        subject_kind: "collection",
        subject_id: input.collection_id,
      });
    }

    return {
      collection_id: row.id,
      title: row.title,
      slug: row.slug,
      updated_at: row.updated_at,
    };
  },
};
