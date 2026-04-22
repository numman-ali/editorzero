/**
 * `workspace.get` — read the caller's workspace metadata
 * (architecture.md §3.2 + §8.3(a) cross-workspace-read posture, ADR 0024).
 *
 * Semantics: read the one `workspaces` row the caller is a member of.
 * Input is empty — the principal already carries `workspace_id` and
 * `ctx.db` is scoped through `WorkspaceScopingPlugin` (ADR 0023), which
 * auto-appends the `workspaces.id = ?` predicate (the table is self-
 * scoped, per-table scope column lookup in `TENANT_SCOPE_COLUMNS`). So
 * the SELECT is table-level with no explicit workspace filter.
 *
 * **Output excludes `diagnostic_salt`.** The salt is an internal
 * per-workspace HMAC key for future `admin.diagnose` (F64) — it is
 * structurally a secret and must never cross the capability boundary.
 * The output schema simply does not include it.
 *
 * **Output excludes `deleted_at`.** Reads filter to `deleted_at IS
 * NULL`; an active caller never sees a soft-deleted workspace through
 * this capability. If the caller's workspace is soft-deleted the
 * handler 404s — the recovery path is `workspace.restore` (future).
 *
 * **Audit — read-collapsible, workspace-scoped.** Reads collapse per
 * `AUDIT_READ_COLLAPSE_WINDOW_MS` (F93). The collapse key is the
 * capability id alone (no input discriminator to vary on) — all
 * `workspace.get` calls by a principal in a window collapse to one
 * audit row.
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const WORKSPACE_GET_ID = CapabilityId("workspace.get");

// ── Input ────────────────────────────────────────────────────────────────
//
// No fields: the principal's `workspace_id` already scopes `ctx.db`. A
// strict empty object rejects smuggled keys (e.g. a client trying to
// pass an `AccessPath.workspace_id` on a capability that has no
// AccessPath surface).

const InputSchema = z.object({}).strict();
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────
//
// `settings` is stored as a TEXT JSON blob in the DB; the handler parses
// it before returning. `z.record(z.string(), z.unknown())` keeps the
// output schema permissive about the exact settings shape (a settings
// schema belongs in a settings-aware capability, not here) while still
// excluding unparseable garbage.

const WorkspaceIdField = z.string().transform((s): WorkspaceId => WorkspaceId(s));
const UserIdField = z.string().transform((s): UserId => UserId(s));

const OutputSchema = z.object({
  workspace_id: WorkspaceIdField,
  slug: z.string(),
  name: z.string(),
  trash_retention_days: z.number(),
  created_by: UserIdField,
  created_at: z.number(),
  settings: z.record(z.string(), z.unknown()),
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const workspaceGet: Capability<Input, Output> = {
  id: WORKSPACE_GET_ID,
  category: "read",
  summary: "Read the caller's workspace metadata (id, slug, name, retention, settings).",
  input: InputSchema,
  output: OutputSchema,
  requires: ["workspace:read"],
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    // Subject is the workspace itself; the audit row's workspace_id
    // column already carries the tenant, so subject_id is left off
    // (mirrors `collection.list` / `doc.list`).
    subjectFrom: () => ({ kind: "workspace" }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: WORKSPACE_GET_ID,
      required_scopes: ["workspace:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(WORKSPACE_GET_ID, error),
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      // No input discriminator — every `workspace.get` by the same
      // principal in the window is the same subject bucket.
      collapseKey: () => "workspace.get",
    },
  },
  handler: async (ctx) => {
    // No `where("id", "=", ...)` — the scoping plugin appends
    // `workspaces.id = <tenant>` automatically (self-scoped; see the
    // `TENANT_SCOPE_COLUMNS` map in `@editorzero/db`). The row is
    // either the caller's workspace or absent (soft-deleted, or —
    // pre-prod edge — bootstrap hook failure).
    const row = await ctx.db
      .selectFrom("workspaces")
      .select([
        "id",
        "slug",
        "name",
        "trash_retention_days",
        "created_by",
        "created_at",
        "settings",
      ])
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (row === undefined) {
      // Soft-deleted workspaces surface as 404; `workspace.restore`
      // (future) owns recovery. Distinguishing "deleted" from "never
      // existed" would leak information about the tenant's lifecycle
      // to a principal who already lost access — 404 is the honest
      // projection.
      throw new NotFoundError({
        subject_kind: "workspace",
        subject_id: ctx.tenant.workspace_id,
      });
    }

    // Settings is a TEXT JSON blob by DDL contract. Bootstrap writes
    // `'{}'`; `workspace.update` will enforce JSON shape before UPDATE.
    // A `JSON.parse` throw here would be an internal-inconsistency
    // signal — but given both writers are server-owned, the parse is
    // trusted. `z.record` on output catches non-object parse results.
    const settings = JSON.parse(row.settings) as Record<string, unknown>;

    return {
      workspace_id: row.id,
      slug: row.slug,
      name: row.name,
      trash_retention_days: row.trash_retention_days,
      created_by: row.created_by,
      created_at: row.created_at,
      settings,
    };
  },
};
