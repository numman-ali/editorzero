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
 * Output IDs are re-branded inside the zod schema (the shared
 * `*OutputSchema` transforms in `@editorzero/schemas`). The DocId /
 * CollectionId factories are idempotent on valid input, so this is a
 * no-op at runtime on rows the db already wrote — it exists so that
 * `z.output<typeof DocListOutputSchema>` preserves the brand, which
 * means callers (API adapter / CLI / MCP) receive typed IDs instead of
 * plain strings without a cast at the boundary. The wire + internal
 * contract lives in `@editorzero/schemas/doc/list` (ADR 0034).
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { CapabilityId } from "@editorzero/ids";
import {
  type DocListInput,
  DocListInputSchema,
  type DocListOutput,
  DocListOutputSchema,
} from "@editorzero/schemas/doc/list";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_LIST_ID = CapabilityId("doc.list");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocListInputSchema` / `DocListOutputSchema` are the single source
// (ADR 0034), defined in `@editorzero/schemas/doc/list` and reused
// verbatim by the API route's `validator` / `resolver`. The input is
// empty (`.strict()` rejects unknown keys); the output IDs are
// re-branded via the shared `*OutputSchema` transforms so consumers
// receive typed IDs without a cast at the boundary. Field-selection
// rationale (list-view columns; internal columns omitted) lives at the
// schema definition.

// ── Capability ───────────────────────────────────────────────────────────

export const docList: Capability<DocListInput, DocListOutput> = {
  id: DOC_LIST_ID,
  category: "read",
  summary: "List all non-deleted docs in the workspace, ordered by order_key.",
  input: DocListInputSchema,
  output: DocListOutputSchema,
  requires: ["doc:read"],
  // "ui" is declared because the Web UI actually binds this capability
  // (the authed home renders it; proven by the marked Playwright spec in
  // packages/e2e). Declared surfaces = bound surfaces (ADR 0040 H11) —
  // packages/contract-tests fails the build if "ui" appears here without
  // a proving spec, or vice versa.
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
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(DOC_LIST_ID, error),
    // Reads collapse: identical calls within the audit-read-collapse
    // window fold into one row with `collapsed_count > 1` on the
    // envelope (§9.3). `collapseKey` is a constant because `doc.list`
    // has no input — two calls with the same principal always
    // collapse. Window sourced from `@editorzero/constants` so the
    // floor is set once repo-wide.
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
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
