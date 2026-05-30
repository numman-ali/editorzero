/**
 * `workspace.member_update_role` wire + internal contract (ADR 0034) — the
 * single source the capability, the API route, and any other surface derive
 * from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`WorkspaceMemberUpdateRoleInputSchema`); types are PascalCase named from
 * the capability contract. A transform-bearing pair has four projections:
 *   - `WorkspaceMemberUpdateRoleWireInput` = `z.input<WorkspaceMemberUpdateRoleInputSchema>`  (wire request)
 *   - `WorkspaceMemberUpdateRoleInput`     = `z.output<WorkspaceMemberUpdateRoleInputSchema>` (branded handler input)
 *   - `WorkspaceMemberUpdateRoleOutput`    = `z.output<WorkspaceMemberUpdateRoleOutputSchema>` (branded response)
 *   - `WorkspaceMemberUpdateRoleWireOutput`= `z.input<WorkspaceMemberUpdateRoleOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers;
 * `WorkspaceMemberUpdateRoleWireOutput` is the reserved name for the
 * response-wire side — add it under that name (never a
 * `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<WorkspaceMemberUpdateRoleInput,
 * WorkspaceMemberUpdateRoleOutput>`; the route feeds
 * `WorkspaceMemberUpdateRoleInputSchema` to `validator` and
 * `WorkspaceMemberUpdateRoleOutputSchema` to `resolver` + `.parse(result)`.
 *
 * Branded-ID fields come from `../shared/ids`; `role` is the shared `ROLES`
 * enum from `@editorzero/scopes`. The membership-op contract keeps `user_id`
 * a plain non-empty string on input (Better-Auth-owned IDs may be UUIDv4;
 * the handler brands it) — see `UserIdInputSchema`'s rationale.
 */

import { ROLES } from "@editorzero/scopes";
import { z } from "zod";

import { UserIdInputSchema, UserIdOutputSchema, WorkspaceIdOutputSchema } from "../shared/ids";

export const WorkspaceMemberUpdateRoleInputSchema = z
  .object({
    user_id: UserIdInputSchema,
    role: z.enum(ROLES),
  })
  .strict();

export const WorkspaceMemberUpdateRoleOutputSchema = z.object({
  workspace_id: WorkspaceIdOutputSchema,
  user_id: UserIdOutputSchema,
  role: z.enum(ROLES),
  updated_at: z.number(),
});

export type WorkspaceMemberUpdateRoleWireInput = z.input<
  typeof WorkspaceMemberUpdateRoleInputSchema
>;
export type WorkspaceMemberUpdateRoleInput = z.output<typeof WorkspaceMemberUpdateRoleInputSchema>;
export type WorkspaceMemberUpdateRoleOutput = z.output<
  typeof WorkspaceMemberUpdateRoleOutputSchema
>;
