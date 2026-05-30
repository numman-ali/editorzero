/**
 * `workspace.member_list` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`WorkspaceMemberListInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `WorkspaceMemberListWireInput` = `z.input<WorkspaceMemberListInputSchema>`  (wire request)
 *   - `WorkspaceMemberListInput`     = `z.output<WorkspaceMemberListInputSchema>` (branded handler input)
 *   - `WorkspaceMemberListOutput`    = `z.output<WorkspaceMemberListOutputSchema>` (branded response)
 *   - `WorkspaceMemberListWireOutput`= `z.input<WorkspaceMemberListOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `WorkspaceMemberListWireOutput`
 * is the reserved name for the response-wire side — add it under that name
 * (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape; the `.transform()` on the
 * shared branded-ID schemas narrows `user_id` to its brand on the response
 * side (`z.output`). The capability uses these as
 * `Capability<WorkspaceMemberListInput, WorkspaceMemberListOutput>`; the
 * route feeds `WorkspaceMemberListInputSchema` to `validator` and
 * `WorkspaceMemberListOutputSchema` to `resolver` + `.parse(result)`.
 *
 * **Coercion (numeric query params).** `limit` and `before_created_at` use
 * `z.coerce.number()` because this schema validates HTTP query strings
 * (where they arrive as strings) as well as CLI/MCP numeric arguments.
 *
 * **One input refine** (copied verbatim from the capability):
 * `(before_created_at, before_user_id)` both-or-neither — a composite
 * cursor with only the timestamp half has no tiebreak. `user_id` is Better
 * Auth-minted (not necessarily UUIDv7) so it is just a secondary sort key.
 * Input is `.strict()` (preserved from the capability): an unknown
 * top-level param is a zod `unrecognized_keys` issue (→ 400), not a silent
 * drop. `.strict()` is applied to the object before `.refine()` because
 * `.refine()` returns a `ZodEffects` wrapper with no `.strict()` method.
 *
 * The `next_cursor` halves stay plain (`before_created_at: number`,
 * `before_user_id: string`) — the cursor is an opaque page token, not a
 * branded-ID-bearing entity.
 */

import { ROLES } from "@editorzero/scopes";
import { z } from "zod";

import { UserIdOutputSchema } from "../shared/ids";

export const WorkspaceMemberListInputSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before_created_at: z.coerce.number().int().optional(),
    before_user_id: z.string().optional(),
    role: z.enum(ROLES).optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.before_created_at === undefined && v.before_user_id === undefined) ||
      (v.before_created_at !== undefined && v.before_user_id !== undefined),
    { message: "before_created_at and before_user_id must be provided together" },
  );

export const WorkspaceMemberListOutputSchema = z.object({
  members: z.array(
    z.object({
      user_id: UserIdOutputSchema,
      role: z.enum(ROLES),
      created_at: z.number(),
      updated_at: z.number(),
    }),
  ),
  next_cursor: z
    .object({
      before_created_at: z.number(),
      before_user_id: z.string(),
    })
    .nullable(),
});

export type WorkspaceMemberListWireInput = z.input<typeof WorkspaceMemberListInputSchema>;
export type WorkspaceMemberListInput = z.output<typeof WorkspaceMemberListInputSchema>;
export type WorkspaceMemberListOutput = z.output<typeof WorkspaceMemberListOutputSchema>;
