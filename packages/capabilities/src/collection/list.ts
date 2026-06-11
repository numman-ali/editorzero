/**
 * `collection.list` — list all non-deleted collections in the workspace
 * scope (architecture.md Appendix A § collection, §8.4 contract matrix).
 *
 * Metadata-only read: one SELECT through `ctx.db`, relying on the
 * `WorkspaceScopingPlugin` for Layer-2 isolation
 * (packages/db/src/tenant.ts). Flat output — callers group by
 * `parent_id` client-side to render the tree. A cursor / per-parent
 * filter can land on the same input schema later without a breaking
 * shape change.
 *
 * **Read-collapse audit** — identical calls within
 * `AUDIT_READ_COLLAPSE_WINDOW_MS` (§9.3, SSOT constant in
 * `@editorzero/constants`) fold into one row with `collapsed_count > 1`
 * on the envelope. Same `collapseKey` policy as `doc.list` (constant
 * key; no input to discriminate).
 *
 * **Ordering** — by `order_key` ascending, matching `doc.list`.
 * `order_key = own_id` (v1 `collection.create`) gives creation-order
 * listing under a single-replica writer; a fractional-index rewrite
 * lands when drag-to-reorder ships (same trajectory as `docs`).
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { CapabilityId } from "@editorzero/ids";
import {
  type CollectionListInput,
  CollectionListInputSchema,
  type CollectionListOutput,
  CollectionListOutputSchema,
} from "@editorzero/schemas/collection/list";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const COLLECTION_LIST_ID = CapabilityId("collection.list");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `CollectionListInputSchema` / `CollectionListOutputSchema` are the single
// source (ADR 0034), reused verbatim by the API route's `validator` /
// `resolver`. Input is the empty object (`.strict()` rejects unknown keys);
// the output is the "list-view ergonomics" shape shared with `doc.list`
// (id, title, slug, parent_id, timestamps). Internal columns (`order_key`,
// `created_by`, `deleted_at`, `workspace_id`) are intentionally omitted —
// the scope is implicit and ordering is applied inside the handler.

// ── Capability ───────────────────────────────────────────────────────────

export const collectionList: Capability<CollectionListInput, CollectionListOutput> = {
  id: COLLECTION_LIST_ID,
  category: "read",
  summary: "List all non-deleted collections in the workspace, ordered by order_key.",
  input: CollectionListInputSchema,
  output: CollectionListOutputSchema,
  requires: ["doc:read"],
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: () => ({ kind: "workspace" }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: COLLECTION_LIST_ID,
      required_scopes: ["doc:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(COLLECTION_LIST_ID, error),
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      collapseKey: () => "collection.list",
    },
  },
  handler: async (ctx) => {
    const rows = await ctx.db
      .selectFrom("collections")
      .select(["id", "title", "slug", "parent_id", "created_at", "updated_at"])
      .where("deleted_at", "is", null)
      .orderBy("order_key")
      .execute();
    return { collections: rows };
  },
};
