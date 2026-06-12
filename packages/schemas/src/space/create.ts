/**
 * `space.create` wire + internal contract (ADR 0034, ADR 0040 Step 8) —
 * the single source the capability, the API route, and every other
 * surface derive from.
 *
 * The capability mints TEAM spaces only: `kind` is NOT an input field
 * (the handler pins `kind = 'team'`, `owner_user_id = NULL`). Personal
 * spaces are signup-seeded exclusively — the `(workspace_id,
 * owner_user_id)` partial unique index + the kind↔owner CHECK make the
 * pair structural, and a second personal-space mint path would have to
 * re-prove both. `slug` is NOT an input: it derives from `name` with
 * the sibling-collision pre-check (the `collection.create` posture);
 * `space.update` owns deliberate slug changes.
 *
 * `space_type` is required — open/closed/private is the org-shaping
 * choice the caller must make explicitly. `baseline_access` defaults
 * to `view` (the least implicit reach; for `private` spaces the value
 * is inert — membership is the only door — but the column is NOT NULL
 * and the stored value becomes live if the type later transitions).
 */

import { z } from "zod";

import { SpaceBaselineAccessSchema, SpaceRowOutputSchema, SpaceTypeSchema } from "../shared/space";

export const SpaceCreateInputSchema = z
  .object({
    name: z.string().trim().min(1, "name must not be empty or whitespace-only").max(200),
    space_type: SpaceTypeSchema,
    baseline_access: SpaceBaselineAccessSchema.default("view"),
  })
  .strict();

export type SpaceCreateWireInput = z.input<typeof SpaceCreateInputSchema>;
export type SpaceCreateInput = z.output<typeof SpaceCreateInputSchema>;

export const SpaceCreateOutputSchema = SpaceRowOutputSchema;
export type SpaceCreateOutput = z.output<typeof SpaceCreateOutputSchema>;
