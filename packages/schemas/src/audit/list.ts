/**
 * `audit.list` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`AuditListInputSchema`); types are PascalCase named from the
 * capability contract:
 *   - `AuditListWireInput` = `z.input<AuditListInputSchema>`   (wire request)
 *   - `AuditListInput`     = `z.output<AuditListInputSchema>`  (handler input)
 *   - `AuditListOutput`    = `z.output<AuditListOutputSchema>` (branded response)
 *   - `AuditListWireOutput` = `z.input<AuditListOutputSchema>` (RESERVED)
 * Export only the projections that have consumers; `AuditListWireOutput`
 * is the reserved name for the response-wire side.
 *
 * **Coercion (numeric query params).** Every numeric input field uses
 * `z.coerce.number()` because this schema validates HTTP query strings
 * (where `limit`, `before_created_at`, `since`, `until` arrive as
 * strings) as well as CLI/MCP numeric arguments. The `.transform()` on
 * the shared branded-ID schemas (via `AuditRowSchema`) narrows
 * `workspace_id` to its brand on the response side; the wire shape stays
 * a plain `string` for external clients (ADR 0033).
 *
 * **Three input refines** (copied verbatim from the capability):
 *   1. `(before_created_at, before_id)` both-or-neither — a composite
 *      cursor with only the timestamp half has no tiebreak;
 *   2. `subject_id` requires `subject_kind` — the (subject_kind,
 *      subject_id, created_at) index only narrows when both are set;
 *   3. `since <= until` when both set — a backwards range returns zero
 *      rows; catch at the boundary to distinguish intent from a typo.
 * The object is `.strict()` (before the refines) so an unknown filter
 * key is a `unrecognized_keys` 400, not a silent drop — the same
 * boundary the capability has carried since the audit slice landed.
 *
 * **Output `events`** is an array of the shared `AuditRowSchema` (the
 * single 19-field audit-row definition), so a field added to one audit
 * surface is carried into `audit.list` without drift.
 */

import { SUBJECT_KINDS } from "@editorzero/scopes";
import { z } from "zod";

import { AuditOutcomeSchema, AuditRowSchema } from "../shared/audit";

export const AuditListInputSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before_created_at: z.coerce.number().int().optional(),
    before_id: z.string().optional(),
    subject_kind: z.enum(SUBJECT_KINDS).optional(),
    subject_id: z.string().optional(),
    capability_id: z.string().optional(),
    outcome: AuditOutcomeSchema.optional(),
    since: z.coerce.number().int().optional(),
    until: z.coerce.number().int().optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.before_created_at === undefined && v.before_id === undefined) ||
      (v.before_created_at !== undefined && v.before_id !== undefined),
    { message: "before_created_at and before_id must be provided together" },
  )
  .refine((v) => v.subject_id === undefined || v.subject_kind !== undefined, {
    message: "subject_id requires subject_kind",
  })
  .refine((v) => v.since === undefined || v.until === undefined || v.since <= v.until, {
    message: "since must be less than or equal to until",
  });

export const AuditListOutputSchema = z.object({
  events: z.array(AuditRowSchema),
  next_cursor: z
    .object({
      before_created_at: z.number(),
      before_id: z.string(),
    })
    .nullable(),
});

export type AuditListWireInput = z.input<typeof AuditListInputSchema>;
export type AuditListInput = z.output<typeof AuditListInputSchema>;
export type AuditListOutput = z.output<typeof AuditListOutputSchema>;
