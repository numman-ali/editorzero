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
import { CapabilityId } from "@editorzero/ids";
import {
  type WorkspaceUpdateInput,
  WorkspaceUpdateInputSchema,
  type WorkspaceUpdateOutput,
  WorkspaceUpdateOutputSchema,
} from "@editorzero/schemas/workspace/update";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const WORKSPACE_UPDATE_ID = CapabilityId("workspace.update");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `WorkspaceUpdateInputSchema` / `WorkspaceUpdateOutputSchema` are the single
// source (ADR 0034), defined in `@editorzero/schemas/workspace/update` and
// reused verbatim by the API route's `validator` / `resolver`. The capability
// semantics that shape them — every input field optional with a
// `.refine(at-least-one)` no-op rejection, `.strict()` rejecting unknown keys,
// `trash_retention_days` bounded to [7, 365] per ADR 0017, `settings` left a
// permissive `record<string, unknown>`, and `updated_at` deliberately absent
// from the output — are documented in the file header above and at the schema
// definition.

// ── Capability ───────────────────────────────────────────────────────────

export const workspaceUpdate: Capability<WorkspaceUpdateInput, WorkspaceUpdateOutput> = {
  id: WORKSPACE_UPDATE_ID,
  category: "mutation",
  summary:
    "Update workspace metadata (name, trash_retention_days, settings); metadata-only, admin-gated.",
  input: WorkspaceUpdateInputSchema,
  output: WorkspaceUpdateOutputSchema,
  requires: ["workspace:admin"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
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
        settings: Record<string, unknown>;
      }> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.trash_retention_days !== undefined) {
        patch.trash_retention_days = input.trash_retention_days;
      }
      // Carry `output.settings`, not `input.settings`: the handler stores
      // `JSON.stringify(input.settings)` and the output is `JSON.parse` of that
      // stored string, so `output.settings` is the exact post-round-trip object
      // a reader (and the replay→DB compare) parses back. Carrying the raw
      // input would diverge for non-JSON-clean values (undefined-valued keys,
      // NaN). Still gated on `input.settings` so the patch stays a delta —
      // settings only enters the patch when the caller actually changed it.
      if (input.settings !== undefined) patch.settings = output.settings;
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
