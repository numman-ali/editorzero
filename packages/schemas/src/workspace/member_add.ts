/**
 * `workspace.member_add` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`WorkspaceMemberAddInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `WorkspaceMemberAddWireInput` = `z.input<WorkspaceMemberAddInputSchema>`  (wire request)
 *   - `WorkspaceMemberAddInput`     = `z.output<WorkspaceMemberAddInputSchema>` (branded handler input)
 *   - `WorkspaceMemberAddOutput`    = `z.output<WorkspaceMemberAddOutputSchema>` (branded response)
 *   - `WorkspaceMemberAddWireOutput`= `z.input<WorkspaceMemberAddOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `WorkspaceMemberAddWireOutput`
 * is the reserved name for the response-wire side — add it under that name
 * (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<WorkspaceMemberAddInput,
 * WorkspaceMemberAddOutput>`; the route feeds `WorkspaceMemberAddInputSchema`
 * to `validator` and `WorkspaceMemberAddOutputSchema` to `resolver` +
 * `.parse(result)`.
 *
 * Branded-ID fields come from `../shared/ids`; `role` is the shared
 * `ROLES` enum from `@editorzero/scopes`. The membership-op contract keeps
 * `user_id` a plain non-empty string on input (Better-Auth-owned IDs may be
 * UUIDv4; the handler brands it) — see `UserIdInputSchema`'s rationale.
 */

import { ROLES } from "@editorzero/scopes";
import { z } from "zod";

import { UserIdInputSchema, UserIdOutputSchema, WorkspaceIdOutputSchema } from "../shared/ids";

export const WorkspaceMemberAddInputSchema = z
  .object({
    user_id: UserIdInputSchema,
    role: z.enum(ROLES),
  })
  .strict();

export const WorkspaceMemberAddOutputSchema = z.object({
  workspace_id: WorkspaceIdOutputSchema,
  user_id: UserIdOutputSchema,
  role: z.enum(ROLES),
  created_at: z.number(),
  updated_at: z.number(),
});

export type WorkspaceMemberAddWireInput = z.input<typeof WorkspaceMemberAddInputSchema>;
export type WorkspaceMemberAddInput = z.output<typeof WorkspaceMemberAddInputSchema>;
export type WorkspaceMemberAddOutput = z.output<typeof WorkspaceMemberAddOutputSchema>;
