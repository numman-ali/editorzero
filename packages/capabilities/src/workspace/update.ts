/**
 * `workspace.update` — mutate workspace metadata (architecture.md §3.2,
 * audit effect `workspace.update` in `@editorzero/audit`,
 * `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`, ADR 0017 for
 * `trash_retention_days` bounds).
 *
 * v1 mutable surface: `name`, `trash_retention_days`, `settings` — all
 * optional, at least one required. Slug is explicitly NOT mutable on
 * this capability: it is derived at bootstrap from the email local-part
 * + workspace-id hash, and re-slugging on name change would orphan
 * outbound links / share URLs keyed on the original slug. A future
 * `workspace.rename` that understands slug-history semantics is a
 * separate slice; this capability deliberately omits the field.
 *
 * Immutable via any capability: `id`, `created_by`, `created_at`,
 * `diagnostic_salt`, `deleted_at` (owned by `workspace.delete` /
 * `.restore`).
 *
 * **Scope.** `workspace:admin` — only `owner` + `admin` roles hold it
 * (mapping in `dispatcher/gate.ts`). Members / guests get
 * `PermissionDeniedError` at Layer 1, never reaching the handler.
 *
 * **Metadata-only.** No `ctx.transact`, no Y.Doc touch — same lane as
 * `collection.update` / `doc.publish`. Single UPDATE on the `workspaces`
 * row wrapped by the dispatcher's write-path tx; the audit row lands
 * in the same tx (F3).
 *
 * **Validation rails.**
 *   - `name.trim().min(1)` matches the existing title-field posture
 *     (closes the visually-blank hole).
 *   - `trash_retention_days` is int in [7, 365] per ADR 0017. The DDL
 *     carries a CHECK constraint as defense-in-depth; here the zod
 *     input surfaces the boundary as a 400.
 *   - `settings` is `z.record(z.string(), z.unknown())` — same
 *     permissiveness as `workspace.get`'s output. A settings-shape
 *     schema belongs in a settings-aware capability, not here. The
 *     handler `JSON.stringify`s before INSERT; the DDL stores TEXT.
 *
 * **No-op rejection.** A call with `{}` is rejected at the input
 * schema via `.refine(at-least-one-field)`. The alternative (accept
 * the no-op and emit an empty `patch: {}`) would pollute the audit
 * log with meaningless entries — and any caller that calls this with
 * no fields is programmer error, not user intent.
 *
 * **Audit patch shape.** The effect records exactly the fields that
 * were updated; absent fields are absent from the patch (not
 * `undefined`). The dispatcher writes this verbatim into the audit
 * row's `effect` column, so a reconstruction walk over the audit log
 * can replay the workspace's mutation history.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId, WorkspaceId } from "@editorzero/ids";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const WORKSPACE_UPDATE_ID = CapabilityId("workspace.update");

// ── Input ────────────────────────────────────────────────────────────────
//
// Every field is optional. The `.refine` guard after the base shape
// requires at least one to be present — reject the no-op patch at the
// boundary (see header "No-op rejection"). `strict()` rejects unknown
// keys BEFORE the refine runs, so a caller passing `{ slug: ... }`
// gets `unrecognized_keys`, not a "no-op" message.

const InputSchema = z
  .object({
    name: z.string().trim().min(1, "name must not be empty or whitespace-only").optional(),
    trash_retention_days: z
      .number()
      .int("trash_retention_days must be an integer")
      .min(7, "trash_retention_days must be at least 7")
      .max(365, "trash_retention_days must be at most 365")
      .optional(),
    // `record<string, unknown>` keeps the shape free-form at this
    // boundary. A settings schema (theme enum, feature flags, ...)
    // belongs in a capability that understands those fields.
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.trash_retention_days !== undefined || v.settings !== undefined,
    { message: "at least one of name, trash_retention_days, settings must be provided" },
  );
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────
//
// Echoes the post-state of the three mutable fields + `workspace_id`
// (the dispatched tenant — surfaces the subject so clients chain
// without re-reading). `updated_at` is NOT present — the `workspaces`
// table deliberately has no `updated_at` column (architecture.md §3.2;
// the audit log is the mutation history). Callers that need an "as
// of" timestamp read the audit row's `created_at`.

const WorkspaceIdField = z.string().transform((s): WorkspaceId => WorkspaceId(s));

const OutputSchema = z.object({
  workspace_id: WorkspaceIdField,
  name: z.string(),
  trash_retention_days: z.number(),
  settings: z.record(z.string(), z.unknown()),
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const workspaceUpdate: Capability<Input, Output> = {
  id: WORKSPACE_UPDATE_ID,
  category: "mutation",
  summary:
    "Update workspace metadata (name, trash_retention_days, settings); metadata-only, admin-gated.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["workspace:admin"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    // Subject is the workspace itself; `id` omitted because the audit
    // row's `workspace_id` column already carries the tenant.
    subjectFrom: () => ({ kind: "workspace" }),
    effectOnAllow: (input, output): AuditEffect => {
      // Patch mirrors the input exactly — only the fields the caller
      // specified go into the audit record. Reconstruction: replay
      // `workspace.update` rows in `created_at` order and merge
      // patches onto the bootstrap row.
      const patch: Partial<{
        name: string;
        trash_retention_days: number;
        settings: unknown;
      }> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.trash_retention_days !== undefined) {
        patch.trash_retention_days = input.trash_retention_days;
      }
      if (input.settings !== undefined) patch.settings = input.settings;
      return {
        kind: "workspace.update",
        // The audit row's top-level `workspace_id` column already
        // carries the tenant; this field on the effect variant pins
        // the effect-local reference (intentional redundancy — the
        // effect is self-contained for offline reconstruction).
        workspace_id: output.workspace_id,
        patch,
      };
    },
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: WORKSPACE_UPDATE_ID,
      required_scopes: ["workspace:admin"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(WORKSPACE_UPDATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    // Build the UPDATE set. Mirrors the input — only specified fields
    // are touched; absent fields retain their prior value. The
    // scoping plugin appends `workspaces.id = <tenant>` automatically
    // (self-scope column — see `TENANT_SCOPE_COLUMNS`), so no manual
    // predicate is required for cross-tenant safety.
    const patch: {
      name?: string;
      trash_retention_days?: number;
      settings?: string;
    } = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.trash_retention_days !== undefined) {
      patch.trash_retention_days = input.trash_retention_days;
    }
    if (input.settings !== undefined) patch.settings = JSON.stringify(input.settings);

    const row = await ctx.db
      .updateTable("workspaces")
      .set(patch)
      .where("deleted_at", "is", null)
      .returning(["id", "name", "trash_retention_days", "settings"])
      .executeTakeFirst();

    if (row === undefined) {
      // Either the workspace was soft-deleted concurrently, or the
      // bootstrap hook never landed the row (pre-prod edge). Both
      // surface as 404 — the subject is genuinely absent from the
      // caller's scoped view.
      throw new NotFoundError({
        subject_kind: "workspace",
        subject_id: ctx.tenant.workspace_id,
      });
    }

    return {
      workspace_id: row.id,
      name: row.name,
      trash_retention_days: row.trash_retention_days,
      settings: JSON.parse(row.settings) as Record<string, unknown>,
    };
  },
};
