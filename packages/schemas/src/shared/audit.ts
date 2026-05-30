/**
 * Shared audit-event row schema (ADR 0034).
 *
 * `AuditRowSchema` is the single definition of one audit-log row. Two
 * capabilities consume it:
 *  - `audit.get` — its output *is* this row.
 *  - `audit.list` — its `output.events` is an array of this row.
 *
 * Defining the row once here keeps those two surfaces from drifting: a
 * field added to `audit.get` is automatically carried into `audit.list`.
 * The enum sub-schemas (`category` / `principal_kind` / `outcome`) are
 * exported alongside so filter inputs on `audit.list` can re-state the
 * same closed sets rather than redeclaring string literals.
 *
 * `AuditEffectSchema` is an open object (`{ kind: string }` plus a
 * `catchall(unknown)`): every effect names its `kind`, but the remaining
 * shape is capability-specific and not pinned at the audit-row boundary.
 *
 * `workspace_id` narrows to the `WorkspaceId` brand on output (read path);
 * all other IDs here are free-form strings — Better-Auth-owned IDs
 * (`session_id` / `token_id` / `acting_as_user_id`) and opaque
 * subject/principal identifiers do not share the product-ID brand.
 */

import { z } from "zod";
import { WorkspaceIdOutputSchema } from "./ids";

export const AuditCategorySchema = z.enum(["mutation", "read", "auth", "admin", "system"]);
export const AuditPrincipalKindSchema = z.enum(["user", "agent"]);
export const AuditOutcomeSchema = z.enum(["allow", "deny", "error"]);
export const AuditEffectSchema = z.object({ kind: z.string() }).catchall(z.unknown());

export const AuditRowSchema = z.object({
  id: z.string(),
  workspace_id: WorkspaceIdOutputSchema,
  capability_id: z.string(),
  category: AuditCategorySchema,
  principal_kind: AuditPrincipalKindSchema,
  principal_id: z.string(),
  acting_as_user_id: z.string().nullable(),
  session_id: z.string().nullable(),
  token_id: z.string().nullable(),
  subject_kind: z.string(),
  subject_id: z.string().nullable(),
  outcome: AuditOutcomeSchema,
  deny_reason: z.string().nullable(),
  input_hash: z.string(),
  effect: AuditEffectSchema,
  duration_ms: z.number(),
  trace_id: z.string().nullable(),
  created_at: z.number(),
  collapsed_count: z.number(),
});
