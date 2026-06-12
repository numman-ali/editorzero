/**
 * `collection.create` — create a folder-tree collection in the caller's
 * workspace (architecture.md §3.5, §8.4 contract matrix).
 *
 * Semantics:
 *   1. Mint a fresh UUIDv7 `collection_id`.
 *   2. If `parent_id` is supplied, SELECT the parent row through
 *      `ctx.db` (tenant-scoped) — 404 if missing or soft-deleted.
 *   3. Walk the ancestor chain to compute the new collection's depth.
 *      Refuse when the chain would exceed `COLLECTION_MAX_DEPTH`.
 *   4. Resolve the space binding + placement standing (two regimes,
 *      below).
 *   5. INSERT the `collections` row. The self-ref composite FK
 *      `(parent_id, workspace_id) REFERENCES collections(id,
 *      workspace_id)` (F99) is the DB-side guard; the handler-side
 *      pre-check exists so the common path surfaces a typed 404 rather
 *      than a bubbled-up SQL FK violation (which would audit as
 *      `internal`).
 *
 * **Space binding (ADR 0040 space-collection slice).** Two regimes,
 * mutually exclusive by the schema rail (`space_id` with `parent_id`
 * is a 400 before the handler runs):
 *   - **Root create** (`parent_id` null): `space_id` is caller input.
 *     `null`/omitted = the legacy no-space bucket, exactly as before —
 *     no resolver load, query count unchanged. A non-null `space_id`
 *     is gated existence-first (missing or soft-deleted space → 404,
 *     the `doc.move` target precedent), then standing via
 *     `assertCanPlaceInSpace` — baseline reach over the destination
 *     bucket (membership / space grant / open-space user baseline).
 *     Non-delegated agents do NOT ride the open-space baseline; they
 *     need an explicit space grant or a delegator with reach (Codex
 *     space-collection review).
 *   - **Child create** (`parent_id` non-null): the binding is
 *     INHERITED from the parent's stored row — derivation, not input.
 *     Standing is `assertCanPlaceIn(parent_id)`: legacy parents are
 *     always placeable, space-bound parents require reach over their
 *     bucket, and an ANOMALOUS parent (dangling/trashed space ref)
 *     fails closed — inheritance can never copy a dangling ref into a
 *     fresh row.
 *
 * **Metadata-only capability** (§6.5, `METADATA_ONLY_CAPABILITIES` in
 * `@editorzero/scopes`). No Y.Doc interaction; a collection is pure
 * relational metadata.
 *
 * **Depth cap.** The 8-level soft cap is a UX pin (Notion-class
 * experience — see `COLLECTION_MAX_DEPTH` docblock in
 * `@editorzero/constants`). Depth 0 is a workspace-root collection,
 * depth 7 is the deepest allowed; a request whose new depth would
 * reach `COLLECTION_MAX_DEPTH` is rejected as `ValidationError` (400)
 * rather than `ConflictError` (409) — the caller's request is
 * structurally invalid, not losing a race.
 *
 * **Ancestor walk cost.** O(depth) SELECTs on the tenant-scoped
 * handle. With the cap at 8 that's a bounded 1–8 round-trips; using
 * a recursive CTE would cut to one round-trip but add dialect-specific
 * SQL that would need to be expressed twice for SQLite + Postgres
 * parity. The iterative walk is the right trade at this cap.
 *
 * **Slug derivation is naive in v1** (same policy as `doc.create`):
 * kebab-case the title; `""` → `"untitled"`. The handler runs a
 * sibling-slug pre-check SELECT (NULL-aware parent scope, matching
 * the partial unique indexes' shape) and throws `SlugCollisionError`
 * (409, `code: "slug_collision"`) on hit — typed 409 on the common
 * path. The DB-side partial unique indexes remain the last-line
 * guard for the race window (pre-check → INSERT with a concurrent
 * sibling); that rare edge still audits as `internal`, but common
 * cases get a typed response. Slice 2 added this to match
 * `collection.update`'s slug-write path (Codex review: asymmetric
 * error shaping between create + update would be worse than
 * consistent).
 *
 * **`created_by` attribution** follows the same policy as
 * `doc.create` (see `resolveCreatedBy`): user principals contribute
 * their own id; agent principals contribute `acting_as` (delegated)
 * or `owner_user_id` (non-delegated). Workspace-owned agents
 * (`owner_user_id === null` without `acting_as`) are refused as
 * `ValidationError` — `collections.created_by: UserId` cannot be
 * satisfied without a user anchor. `agentAllowed: {}` covers the
 * typical owner-scoped agent path; unconditional agent support
 * waits on a schema widening (`created_by: UserId | AgentId`).
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
import {
  CapabilityId,
  type CollectionId,
  generateCollectionId,
  type SpaceId,
} from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import {
  type CollectionCreateInput,
  CollectionCreateInputSchema,
  type CollectionCreateOutput,
  CollectionCreateOutputSchema,
} from "@editorzero/schemas/collection/create";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_CREATE_ID = CapabilityId("collection.create");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `CollectionCreateInputSchema` / `CollectionCreateOutputSchema` are the
// single source (ADR 0034), imported from `@editorzero/schemas/collection/
// create` and reused verbatim by the API route's `validator` / `resolver`
// so the wire contract has exactly one definition. `z.input` is the wire
// shape (plain strings); each field's `.transform()` narrows to the branded
// internal shape — `CollectionCreateInput` / `CollectionCreateOutput`. The
// capability semantics that shape these (`.strict()` rejecting unknown keys,
// the trim-then-`min(1)` title rule, `parent_id` null-or-omitted) are
// documented in the file header above and at the schema definition.

// ── Helpers ──────────────────────────────────────────────────────────────

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "untitled";
}

function resolveCreatedBy(principal: Principal) {
  if (principal.kind === "user") return principal.id;
  if (principal.acting_as !== undefined) return principal.acting_as;
  if (principal.owner_user_id !== null) return principal.owner_user_id;
  throw new ValidationError({
    message:
      "collection.create: agent principal has neither `acting_as` nor `owner_user_id` set; " +
      "cannot attribute `collections.created_by` to a human in v1.",
    issues: [
      {
        code: "unattributable_agent",
        message:
          "workspace-owned agent principal requires a delegated `acting_as` " +
          "(agent-auth token) or a non-null `owner_user_id` for collection.create",
        path: ["principal"],
      },
    ],
  });
}

// ── Capability ───────────────────────────────────────────────────────────

export const collectionCreate: Capability<CollectionCreateInput, CollectionCreateOutput> = {
  id: COLLECTION_CREATE_ID,
  category: "mutation",
  summary:
    "Create a new collection (folder) in the caller's workspace; roots at workspace level when `parent_id` is null.",
  input: CollectionCreateInputSchema,
  output: CollectionCreateOutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  // "ui" landed with the sidebar Collections section's "+" disclosure
  // (the collection.create × Web UI cell) — proven end-to-end by the
  // marked Playwright spec in packages/e2e (proves-capability-cell:
  // collection.create).
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: () => ({ kind: "collection" }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "collection.create",
      collection_id: output.collection_id,
      workspace_id: output.workspace_id,
      parent_id: output.parent_id,
      space_id: output.space_id,
      title: output.title,
      slug: output.slug,
      order_key: output.order_key,
      created_by: output.created_by,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: COLLECTION_CREATE_ID,
      required_scopes: ["doc:write"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(COLLECTION_CREATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const collection_id = generateCollectionId();
    const workspace_id = ctx.tenant.workspace_id;
    const parent_id: CollectionId | null = input.parent_id ?? null;
    const requested_space_id = input.space_id ?? null;
    const title = input.title;
    const slug = slugify(title);
    const now = ctx.now();
    const created_by = resolveCreatedBy(ctx.principal);
    // Single-replica append order — same `order_key = own_id` pattern as
    // `doc.create`. Multi-replica deployments swap to a fractional
    // index or a cross-replica seq when that infra lands (architecture.md
    // §3.5).
    const order_key = collection_id;

    // Resolved space binding of the new row: caller-requested on a
    // root create (placement-standing-gated below), INHERITED from the
    // parent's stored row on a child create (derivation, not input —
    // the schema rail rejects `space_id` alongside `parent_id`).
    let space_id: typeof requested_space_id = requested_space_id;

    // Parent validation + depth walk. The loop doubles as the "parent
    // exists and is live" check: on the first iteration `cursor =
    // parent_id`, and a missing/soft-deleted row surfaces as 404 with
    // the caller-supplied id. Subsequent iterations defend against a
    // mid-chain soft-delete (architecturally forbidden by
    // `collection.delete`'s live-descendants-only rule, but we fail
    // closed rather than trust the invariant).
    if (parent_id !== null) {
      let new_depth = 0;
      let cursor: CollectionId | null = parent_id;
      while (cursor !== null) {
        new_depth += 1;
        if (new_depth >= COLLECTION_MAX_DEPTH) {
          throw new ValidationError({
            message: `collection.create: nesting depth would exceed the ${COLLECTION_MAX_DEPTH}-level cap`,
            issues: [
              {
                code: "depth_cap_exceeded",
                message: `collections may be at most ${COLLECTION_MAX_DEPTH} levels deep`,
                path: ["parent_id"],
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
        if (cursor === parent_id) space_id = row.space_id;
        cursor = row.parent_id;
      }

      // Placement standing over the parent's bucket — the literal
      // `doc.create` term, one level up: legacy parents are always
      // placeable, space-bound parents require baseline reach
      // (membership / space grant / open-space user baseline — agents
      // need an explicit grant or a delegator), and an ANOMALOUS
      // parent (dangling or trashed space ref) fails closed, which
      // also means inheritance can never copy a dangling ref into a
      // fresh row.
      const acl = await loadDocReadResolver(ctx.db, ctx.principal);
      acl.assertCanPlaceIn(parent_id);
    } else if (requested_space_id !== null) {
      // Root create INTO a space. Existence first (the doc.move
      // target-404 precedent — live-object surface), then standing via
      // the resolver's own term (`assertCanPlaceInSpace` — agents do
      // NOT ride the open-space user baseline; Codex space-collection
      // review).
      const space = await ctx.db
        .selectFrom("spaces")
        .select(["id"])
        .where("id", "=", requested_space_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (space === undefined) {
        throw new NotFoundError({ subject_kind: "space", subject_id: requested_space_id });
      }
      const acl = await loadDocReadResolver(ctx.db, ctx.principal);
      acl.assertCanPlaceInSpace(requested_space_id);
    }

    // Sibling-slug pre-check. Typed 409 on the common path rather
    // than letting the partial unique index bubble as `internal`.
    // NULL-aware parent scope matches the two indexes the DDL
    // defines (one for root, one for nested). The race window
    // (this SELECT → the INSERT below) is still guarded by the
    // indexes as the last-line enforcement — an interleaved
    // concurrent sibling insert would re-raise as a UNIQUE
    // violation / `internal` audit.
    let existing: { id: CollectionId } | undefined;
    if (parent_id === null) {
      existing = await ctx.db
        .selectFrom("collections")
        .select(["id"])
        .where("parent_id", "is", null)
        .where("slug", "=", slug)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
    } else {
      existing = await ctx.db
        .selectFrom("collections")
        .select(["id"])
        .where("parent_id", "=", parent_id)
        .where("slug", "=", slug)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
    }
    if (existing !== undefined) {
      throw new SlugCollisionError({
        slug,
        parent_kind: parent_id === null ? "workspace" : "collection",
        parent_id,
      });
    }

    await ctx.db
      .insertInto("collections")
      .values({
        id: collection_id,
        workspace_id,
        parent_id,
        space_id,
        title,
        slug,
        order_key,
        created_by,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .execute();

    return {
      collection_id,
      workspace_id,
      parent_id,
      space_id,
      title,
      slug,
      order_key,
      created_by,
    };
  },
};
