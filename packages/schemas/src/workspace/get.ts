/**
 * `workspace.get` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`WorkspaceGetInputSchema`); types are PascalCase named from the
 * capability contract:
 *   - `WorkspaceGetWireInput` = `z.input<WorkspaceGetInputSchema>`   (wire request)
 *   - `WorkspaceGetInput`     = `z.output<WorkspaceGetInputSchema>`  (branded handler input)
 *   - `WorkspaceGetOutput`    = `z.output<WorkspaceGetOutputSchema>` (branded response)
 * Reserved (add only when a consumer needs it):
 *   - `WorkspaceGetWireOutput` = `z.input<WorkspaceGetOutputSchema>` (wire response).
 *
 * Input is an empty `.strict()` object — `z.input` and `z.output` coincide,
 * but both type projections are exported so the contract stays uniform. The
 * output's branded-ID fields (`workspace_id`, `created_by`) come from
 * `../shared/ids`: on the wire / in the generated OpenAPI they are plain
 * `string`; for in-process `hc` consumers they are the brand (ADR 0033).
 * `settings` stays a permissive `z.record(z.string(), z.unknown())` — a
 * settings-shape schema belongs in a settings-aware capability, not here.
 */

import { z } from "zod";

import { UserIdOutputSchema, WorkspaceIdOutputSchema } from "../shared/ids";

// No fields: the principal's `workspace_id` already scopes `ctx.db`. A
// strict empty object rejects smuggled keys (e.g. a client trying to
// pass an `AccessPath.workspace_id` on a capability that has no
// AccessPath surface).
export const WorkspaceGetInputSchema = z.object({}).strict();

// `settings` is stored as a TEXT JSON blob in the DB; the handler parses
// it before returning. `z.record(z.string(), z.unknown())` keeps the
// output schema permissive about the exact settings shape while still
// excluding unparseable garbage.
export const WorkspaceGetOutputSchema = z.object({
  workspace_id: WorkspaceIdOutputSchema,
  slug: z.string(),
  name: z.string(),
  trash_retention_days: z.number(),
  created_by: UserIdOutputSchema,
  created_at: z.number(),
  settings: z.record(z.string(), z.unknown()),
});

export type WorkspaceGetWireInput = z.input<typeof WorkspaceGetInputSchema>;
export type WorkspaceGetInput = z.output<typeof WorkspaceGetInputSchema>;
export type WorkspaceGetOutput = z.output<typeof WorkspaceGetOutputSchema>;
