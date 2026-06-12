/**
 * `space.member_add` wire + internal contract (ADR 0034, ADR 0040 Step 8).
 *
 * Mirrors `workspace/member_add` with two deltas: the roster is keyed by
 * `(space_id, user_id)` (so `space_id` joins the input), and the role
 * vocabulary is `GRANT_ROLES` (owner/edit/comment/view — the space-member
 * role feeds baseline reach through the Step-6 resolver), NOT the
 * workspace `ROLES`. `user_id` stays a plain non-empty string on input
 * (Better-Auth-owned IDs may be UUIDv4; the handler brands it) — see
 * `UserIdInputSchema`'s rationale.
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

const SpaceMemberAddBaseSchema = z
  .object({
    space_id: SpaceIdInputSchema,
    user_id: UserIdInputSchema,
    role: z.enum(GRANT_ROLES),
  })
  .strict();

export const SpaceMemberAddInputSchema = SpaceMemberAddBaseSchema;

// Route-side request pieces (P3 — path param + JSON body merged into
// one capability input). Derived from the SAME base object — no
// restated field.
export const SpaceMemberAddParamSchema = SpaceMemberAddBaseSchema.pick({ space_id: true });
export const SpaceMemberAddBodySchema = SpaceMemberAddBaseSchema.omit({ space_id: true });

export const SpaceMemberAddOutputSchema = z.object({
  workspace_id: WorkspaceIdOutputSchema,
  space_id: SpaceIdOutputSchema,
  user_id: UserIdOutputSchema,
  role: z.enum(GRANT_ROLES),
  created_at: z.number(),
  updated_at: z.number(),
});

export type SpaceMemberAddWireInput = z.input<typeof SpaceMemberAddInputSchema>;
export type SpaceMemberAddInput = z.output<typeof SpaceMemberAddInputSchema>;
export type SpaceMemberAddOutput = z.output<typeof SpaceMemberAddOutputSchema>;
