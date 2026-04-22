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
 *   4. INSERT the `collections` row. The self-ref composite FK
 *      `(parent_id, workspace_id) REFERENCES collections(id,
 *      workspace_id)` (F99) is the DB-side guard; the handler-side
 *      pre-check exists so the common path surfaces a typed 404 rather
 *      than a bubbled-up SQL FK violation (which would audit as
 *      `internal`).
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
 * kebab-case the title; `""` → `"untitled"`. The partial unique
 * indexes on `(workspace_id, parent_id, slug)` (two indexes for
 * NULL-aware uniqueness) will reject sibling-slug collisions as a
 * SQL UNIQUE violation — audited as `internal` for now. A retry-on-
 * slug loop lands here when sibling-slug collision is a real UX
 * concern; v1 treats it as "fix your title."
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
import { NotFoundError, ValidationError } from "@editorzero/errors";
import { CapabilityId, CollectionId, generateCollectionId, WorkspaceId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_CREATE_ID = CapabilityId("collection.create");

// ── Input ────────────────────────────────────────────────────────────────

const ParentIdInput = z
  .uuid({ version: "v7", message: "parent_id must be a UUIDv7" })
  .transform((s): CollectionId => CollectionId(s));

const InputSchema = z
  .object({
    // `.trim()` strips surrounding whitespace before the non-empty
    // check; `"   "` trims to `""` and fails validation (same pattern
    // as `doc.create`).
    title: z.string().trim().min(1, "title must not be empty or whitespace-only"),
    // `null` (explicit root) is distinct from "missing" (also root) on
    // the wire; both coerce to `null` on the DB side. Accepting both
    // avoids a caller-side "omit the field if it's null" dance.
    parent_id: ParentIdInput.nullable().optional(),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────

const CollectionIdField = z.string().transform((s): CollectionId => CollectionId(s));
const WorkspaceIdField = z.string().transform((s): WorkspaceId => WorkspaceId(s));
const NullableCollectionIdField = z
  .string()
  .nullable()
  .transform((s): CollectionId | null => (s === null ? null : CollectionId(s)));

const OutputSchema = z.object({
  collection_id: CollectionIdField,
  workspace_id: WorkspaceIdField,
  parent_id: NullableCollectionIdField,
  title: z.string(),
  slug: z.string(),
  order_key: z.string(),
});
type Output = z.infer<typeof OutputSchema>;

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

export const collectionCreate: Capability<Input, Output> = {
  id: COLLECTION_CREATE_ID,
  category: "mutation",
  summary:
    "Create a new collection (folder) in the caller's workspace; roots at workspace level when `parent_id` is null.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: () => ({ kind: "collection" }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "collection.create",
      collection_id: output.collection_id,
      workspace_id: output.workspace_id,
      parent_id: output.parent_id,
      title: output.title,
      slug: output.slug,
      order_key: output.order_key,
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
    const title = input.title;
    const slug = slugify(title);
    const now = ctx.now();
    const created_by = resolveCreatedBy(ctx.principal);
    // Single-replica append order — same `order_key = own_id` pattern as
    // `doc.create`. Multi-replica deployments swap to a fractional
    // index or a cross-replica seq when that infra lands (architecture.md
    // §3.5).
    const order_key = collection_id;

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
    }

    await ctx.db
      .insertInto("collections")
      .values({
        id: collection_id,
        workspace_id,
        parent_id,
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
      title,
      slug,
      order_key,
    };
  },
};
