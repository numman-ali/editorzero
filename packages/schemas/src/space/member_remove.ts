/**
 * `space.member_remove` wire + internal contract (ADR 0034, ADR 0040
 * Step 8).
 *
 * `space_members` is a hard-DELETE table (no `deleted_at` — Step-4 DDL),
 * so unlike `workspace/member_remove` the output is the FULL row
 * preimage (`role` included): after the DELETE, this echo and the
 * `space.member_remove` audit row are the only durable records of what
 * membership existed (the Codex Step-7 preimage rule).
 */

import { GRANT_ROLES } from "@editorzero/scopes";
import { z } from "zod";

import {
  SpaceIdInputSchema,
  SpaceIdOutputSchema,
  UserIdInputSchema,
  UserIdOutputSchema,
  WorkspaceIdOutputSchema,
} from "../shared/ids";

const SpaceMemberRemoveBaseSchema = z
  .object({
    space_id: SpaceIdInputSchema,
    user_id: UserIdInputSchema,
  })
  .strict();

export const SpaceMemberRemoveInputSchema = SpaceMemberRemoveBaseSchema;

// Route-side request pieces (P3 — path param + JSON body merged into
// one capability input). Derived from the SAME base object — no
// restated field.
export const SpaceMemberRemoveParamSchema = SpaceMemberRemoveBaseSchema.pick({ space_id: true });
export const SpaceMemberRemoveBodySchema = SpaceMemberRemoveBaseSchema.omit({ space_id: true });

export const SpaceMemberRemoveOutputSchema = z.object({
  workspace_id: WorkspaceIdOutputSchema,
  space_id: SpaceIdOutputSchema,
  user_id: UserIdOutputSchema,
  role: z.enum(GRANT_ROLES),
});

export type SpaceMemberRemoveWireInput = z.input<typeof SpaceMemberRemoveInputSchema>;
export type SpaceMemberRemoveInput = z.output<typeof SpaceMemberRemoveInputSchema>;
export type SpaceMemberRemoveOutput = z.output<typeof SpaceMemberRemoveOutputSchema>;
