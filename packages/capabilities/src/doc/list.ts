/**
 * `doc.list` — list all non-deleted docs in the workspace scope
 * (architecture.md Appendix A § doc).
 *
 * The first real capability. Metadata-only read: issues a single
 * SELECT against `docs` through the tenant-scoped `ctx.db`, relying
 * on the `WorkspaceScopingPlugin` to enforce Layer-2 isolation
 * (packages/db/src/tenant.ts). No pagination in v1 — a later
 * sub-slice will add cursor-based paging behind the same input
 * schema (a field becomes non-optional; no breaking shape change).
 *
 * Output IDs are re-branded inside the zod schema via
 * `z.string().transform(...)`. The DocId / CollectionId factories
 * are idempotent on valid input, so this is a no-op at runtime on
 * rows the db already wrote — it exists so that
 * `z.infer<typeof OutputSchema>` preserves the brand, which means
 * callers (API adapter / CLI / MCP) receive typed IDs instead of
 * plain strings without a cast at the boundary.
 */

import { CapabilityId, CollectionId, DocId } from "@editorzero/ids";
import { z } from "zod";

import type { Capability } from "../kernel";

const DOC_LIST_ID = CapabilityId("doc.list");

// ── Input ────────────────────────────────────────────────────────────────

const InputSchema = z.object({}).strict();
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────
//
// Fields chosen for the "list view" use case: enough to render a
// navigable document list (id, title, visibility, collection,
// timestamps). Internal columns (`order_key`, `visibility_version`,
// `deleted_at`, `workspace_id`) are intentionally omitted — the
// scope is implicit; the ordering is applied inside the handler.

const DocIdField = z.string().transform((s): DocId => DocId(s));
const CollectionIdField = z
  .string()
  .nullable()
  .transform((s): CollectionId | null => (s === null ? null : CollectionId(s)));

const DocSummarySchema = z.object({
  id: DocIdField,
  title: z.string(),
  slug: z.string(),
  collection_id: CollectionIdField,
  visibility: z.enum(["workspace", "public", "private"]),
  created_at: z.number(),
  updated_at: z.number(),
});

const OutputSchema = z.object({
  docs: z.array(DocSummarySchema),
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const docList: Capability<Input, Output> = {
  id: DOC_LIST_ID,
  category: "read",
  summary: "List all non-deleted docs in the workspace, ordered by order_key.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["doc:read"],
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: () => ({ kind: "workspace" }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: DOC_LIST_ID,
      required_scopes: ["doc:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, _error) => ({
      kind: "error",
      capability: DOC_LIST_ID,
      error_code: "internal",
      retriable: false,
    }),
    // Reads collapse: identical calls within 1s fold into one row
    // with `collapsed_count > 1` on the envelope. `collapseKey` is a
    // constant because `doc.list` has no input — two calls with the
    // same principal always collapse.
    collapsePolicy: {
      collapsible: true,
      window_ms: 1000,
      collapseKey: () => "doc.list",
    },
  },
  handler: async (ctx) => {
    const rows = await ctx.db
      .selectFrom("docs")
      .select(["id", "title", "slug", "collection_id", "visibility", "created_at", "updated_at"])
      .where("deleted_at", "is", null)
      .orderBy("order_key")
      .execute();
    return { docs: rows };
  },
};
