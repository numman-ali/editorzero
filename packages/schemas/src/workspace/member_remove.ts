/**
 * `workspace.member_remove` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`WorkspaceMemberRemoveInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `WorkspaceMemberRemoveWireInput` = `z.input<WorkspaceMemberRemoveInputSchema>`  (wire request)
 *   - `WorkspaceMemberRemoveInput`     = `z.output<WorkspaceMemberRemoveInputSchema>` (branded handler input)
 *   - `WorkspaceMemberRemoveOutput`    = `z.output<WorkspaceMemberRemoveOutputSchema>` (branded response)
 *   - `WorkspaceMemberRemoveWireOutput`= `z.input<WorkspaceMemberRemoveOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `WorkspaceMemberRemoveWireOutput`
 * is the reserved name for the response-wire side — add it under that name
 * (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<WorkspaceMemberRemoveInput,
 * WorkspaceMemberRemoveOutput>`; the route feeds `WorkspaceMemberRemoveInputSchema`
 * to `validator` and `WorkspaceMemberRemoveOutputSchema` to `resolver` +
 * `.parse(result)`.
 *
 * Branded-ID fields come from `../shared/ids`. The membership-op contract keeps
 * `user_id` a plain non-empty string on input (Better-Auth-owned IDs may be
 * UUIDv4; the handler brands it) — see `UserIdInputSchema`'s rationale.
 */

import { z } from "zod";

import { UserIdInputSchema, UserIdOutputSchema, WorkspaceIdOutputSchema } from "../shared/ids";

export const WorkspaceMemberRemoveInputSchema = z
  .object({
    user_id: UserIdInputSchema,
  })
  .strict();

export const WorkspaceMemberRemoveOutputSchema = z.object({
  workspace_id: WorkspaceIdOutputSchema,
  user_id: UserIdOutputSchema,
  deleted_at: z.number(),
});

export type WorkspaceMemberRemoveWireInput = z.input<typeof WorkspaceMemberRemoveInputSchema>;
export type WorkspaceMemberRemoveInput = z.output<typeof WorkspaceMemberRemoveInputSchema>;
export type WorkspaceMemberRemoveOutput = z.output<typeof WorkspaceMemberRemoveOutputSchema>;
