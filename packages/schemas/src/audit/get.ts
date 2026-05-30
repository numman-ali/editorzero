/**
 * `audit.get` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`AuditGetInputSchema`); types are PascalCase named from the
 * capability contract:
 *   - `AuditGetWireInput`  = `z.input<AuditGetInputSchema>`   (wire request)
 *   - `AuditGetInput`      = `z.output<AuditGetInputSchema>`  (handler input)
 *   - `AuditGetOutput`     = `z.output<AuditGetOutputSchema>` (branded response)
 * The reserved `AuditGetWireOutput` (= `z.input<AuditGetOutputSchema>`)
 * has no consumer and is intentionally not exported.
 *
 * `audit_id` is **unbranded** — no `AuditId` brand exists, so the field
 * stays a raw `z.uuid({ version: "v7" })` with no `.transform()`. The
 * input is therefore wire-identical to its handler shape; only the
 * `Output` side narrows `workspace_id` to its brand via `AuditRowSchema`.
 *
 * **Output is the audit row itself.** `AuditGetOutputSchema` is the shared
 * `AuditRowSchema` (`../shared/audit`) — not wrapped, not `.strict()` — so
 * `audit.get` and `audit.list` cannot drift on the row shape.
 */

import { z } from "zod";

import { AuditRowSchema } from "../shared/audit";

export const AuditGetInputSchema = z
  .object({
    audit_id: z.uuid({ version: "v7", message: "audit_id must be a UUIDv7" }),
  })
  .strict();

export const AuditGetOutputSchema = AuditRowSchema;

export type AuditGetWireInput = z.input<typeof AuditGetInputSchema>;
export type AuditGetInput = z.output<typeof AuditGetInputSchema>;
export type AuditGetOutput = z.output<typeof AuditGetOutputSchema>;
