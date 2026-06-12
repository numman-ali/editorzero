/**
 * `audit.get` — fetch a single `audit_events` row by primary key
 * (architecture.md §3.11).
 *
 * Admin-only, paired with `audit.list`. Kept as a distinct capability
 * from `audit.list --id=...` so the CLI/MCP surface reads
 * naturally (`ez audits get <id>`, `audit.get` MCP tool) and the
 * audit-event row's surfaces map cleanly into the ADR 0021 plural-
 * action convention.
 *
 * **Subject on 404.** The `audit_events` row id is not one of the
 * `SUBJECT_KINDS` values (widening that enum would cascade through
 * schema + audit + tests). The NotFoundError therefore projects
 * `subject_kind: "workspace"` with the tenant's own workspace_id —
 * honest projection: "no audit row with this id is visible in
 * workspace W." The requested id appears in the error message.
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type AuditGetInput,
  AuditGetInputSchema,
  type AuditGetOutput,
  AuditGetOutputSchema,
} from "@editorzero/schemas/audit/get";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const AUDIT_GET_ID = CapabilityId("audit.get");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `AuditGetInputSchema` / `AuditGetOutputSchema` are the single source
// (ADR 0034), reused verbatim by the API route. `audit_id` is named to
// match the `<domain>_id` CLI-binding convention (see
// `apps/cli/src/generator/http-binding.ts`): input field named `audit_id`
// auto-derives path `/audits/get/:audit_id` and a positional `<audit_id>`
// CLI argument. The handler maps it to the `id` column. The output is the
// shared `AuditRowSchema` (identical to `audit.list` elements), defined
// once in `@editorzero/schemas/shared/audit` so the two surfaces cannot
// drift on the row shape.

// ── Capability ───────────────────────────────────────────────────────────

export const auditGet: Capability<AuditGetInput, AuditGetOutput> = {
  id: AUDIT_GET_ID,
  category: "read",
  summary: "Fetch a single audit event by id; admin-only.",
  input: AuditGetInputSchema,
  output: AuditGetOutputSchema,
  requires: ["workspace:admin"],
  // "ui" landed with the /audit/$auditId detail screen (the audit.get ×
  // Web UI cell — the full forensic record) — proven end-to-end by the
  // marked Playwright spec in packages/e2e
  // (proves-capability-cell: audit.get).
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: () => ({ kind: "workspace" }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: AUDIT_GET_ID,
      required_scopes: ["workspace:admin"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(AUDIT_GET_ID, error),
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      // Per-id bucket (mirrors `doc.get`): the policy declares that
      // two `audit.get` calls on the same row within the window
      // collapse, two different rows do not. Backend collapse is
      // deferred at the writer (`packages/db/src/audit-writer.ts` —
      // `collapsed_count` is always 1 today); this key is the shape
      // the writer will honour when the collapse slice lands.
      collapseKey: (input) => `audit.get:${(input as AuditGetInput).audit_id}`,
    },
  },
  handler: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom("audit_events")
      .select([
        "id",
        "workspace_id",
        "capability_id",
        "category",
        "principal_kind",
        "principal_id",
        "acting_as_user_id",
        "session_id",
        "token_id",
        "subject_kind",
        "subject_id",
        "outcome",
        "deny_reason",
        "input_hash",
        "effect",
        "duration_ms",
        "trace_id",
        "created_at",
        "collapsed_count",
      ])
      .where("id", "=", input.audit_id)
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({
        subject_kind: "workspace",
        subject_id: ctx.tenant.workspace_id,
        message: `audit event ${input.audit_id} not found in workspace ${ctx.tenant.workspace_id}`,
      });
    }

    return {
      ...row,
      effect: JSON.parse(row.effect) as { kind: string } & Record<string, unknown>,
    };
  },
};
