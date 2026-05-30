/**
 * `workspace.update` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`WorkspaceUpdateInputSchema`); types are PascalCase named from the
 * capability contract:
 *   - `WorkspaceUpdateWireInput` = `z.input<WorkspaceUpdateInputSchema>`   (wire request)
 *   - `WorkspaceUpdateInput`     = `z.output<WorkspaceUpdateInputSchema>`  (branded handler input)
 *   - `WorkspaceUpdateOutput`    = `z.output<WorkspaceUpdateOutputSchema>` (branded response)
 * Reserved (add only when a consumer needs it):
 *   - `WorkspaceUpdateWireOutput` = `z.input<WorkspaceUpdateOutputSchema>` (wire response).
 *
 * Every input field is optional; the `.refine` after the base shape requires
 * at least one to be present — the no-op `{}` patch is rejected at the
 * boundary. `.strict()` rejects unknown keys BEFORE the refine runs, so a
 * caller passing `{ slug: ... }` gets `unrecognized_keys`, not a "no-op"
 * message. `trash_retention_days` is an int in [7, 365] per ADR 0017; this is
 * a JSON body so it is `z.number()` (not coerced). `settings` stays a
 * permissive `z.record(z.string(), z.unknown())` — a settings-shape schema
 * belongs in a settings-aware capability, not here.
 *
 * The output's `workspace_id` comes from `../shared/ids`: on the wire / in the
 * generated OpenAPI it is a plain `string`; for in-process `hc` consumers it
 * is the brand (ADR 0033). `updated_at` is intentionally absent — the
 * `workspaces` table has no `updated_at` column (architecture.md §3.2; the
 * audit log is the mutation history).
 */

import { z } from "zod";

import { WorkspaceIdOutputSchema } from "../shared/ids";

export const WorkspaceUpdateInputSchema = z
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

export const WorkspaceUpdateOutputSchema = z.object({
  workspace_id: WorkspaceIdOutputSchema,
  name: z.string(),
  trash_retention_days: z.number(),
  settings: z.record(z.string(), z.unknown()),
});

export type WorkspaceUpdateWireInput = z.input<typeof WorkspaceUpdateInputSchema>;
export type WorkspaceUpdateInput = z.output<typeof WorkspaceUpdateInputSchema>;
export type WorkspaceUpdateOutput = z.output<typeof WorkspaceUpdateOutputSchema>;
