/**
 * `space.member_update_role` wire + internal contract (ADR 0034,
 * ADR 0040 Step 8).
 *
 * Mirrors `workspace/member_update_role` keyed by `(space_id, user_id)`
 * with the `GRANT_ROLES` vocabulary (the space-member role feeds
 * baseline reach, not workspace administration).
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

const SpaceMemberUpdateRoleBaseSchema = z
  .object({
    space_id: SpaceIdInputSchema,
    user_id: UserIdInputSchema,
    role: z.enum(GRANT_ROLES),
  })
  .strict();

export const SpaceMemberUpdateRoleInputSchema = SpaceMemberUpdateRoleBaseSchema;

// Route-side request pieces (P3 — path param + JSON body merged into
// one capability input). Derived from the SAME base object — no
// restated field.
export const SpaceMemberUpdateRoleParamSchema = SpaceMemberUpdateRoleBaseSchema.pick({
  space_id: true,
});
export const SpaceMemberUpdateRoleBodySchema = SpaceMemberUpdateRoleBaseSchema.omit({
  space_id: true,
});

export const SpaceMemberUpdateRoleOutputSchema = z.object({
  workspace_id: WorkspaceIdOutputSchema,
  space_id: SpaceIdOutputSchema,
  user_id: UserIdOutputSchema,
  role: z.enum(GRANT_ROLES),
  updated_at: z.number(),
});

export type SpaceMemberUpdateRoleWireInput = z.input<typeof SpaceMemberUpdateRoleInputSchema>;
export type SpaceMemberUpdateRoleInput = z.output<typeof SpaceMemberUpdateRoleInputSchema>;
export type SpaceMemberUpdateRoleOutput = z.output<typeof SpaceMemberUpdateRoleOutputSchema>;
