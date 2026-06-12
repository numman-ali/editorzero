/**
 * `space.restore` wire + internal contract (ADR 0034, ADR 0040 Step 8).
 *
 * Param-only input; minimal `{space_id}` echo (the `collection.restore`
 * shape — a client wanting the revived row lists/gets it). Restore is a
 * 1:1 inverse of `space.archive`: grants ride through untouched (H1 —
 * state-as-of-delete), members were emptied before the archive could
 * land, and the slug/personal-uniqueness preconditions are handler-side
 * typed 409s, not schema concerns.
 */

import { z } from "zod";

import { SpaceIdInputSchema, SpaceIdOutputSchema } from "../shared/ids";

export const SpaceRestoreInputSchema = z
  .object({
    space_id: SpaceIdInputSchema,
  })
  .strict();

export const SpaceRestoreOutputSchema = z.object({
  space_id: SpaceIdOutputSchema,
});

export type SpaceRestoreWireInput = z.input<typeof SpaceRestoreInputSchema>;
export type SpaceRestoreInput = z.output<typeof SpaceRestoreInputSchema>;
export type SpaceRestoreOutput = z.output<typeof SpaceRestoreOutputSchema>;
