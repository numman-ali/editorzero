/**
 * `space.archive` wire + internal contract (ADR 0034, ADR 0040 Step 8).
 *
 * "Archive" is the ADR 0040 vocabulary for the spaces soft-delete.
 * Param-only input (the `collection.delete` shape); the output mirrors
 * `collection.delete`'s `{id, deleted_at}` echo — the refusal payload
 * (live collections/docs/members counts) rides the typed
 * `SpaceHasLiveDescendantsError`, not this schema.
 */

import { z } from "zod";

import { SpaceIdInputSchema, SpaceIdOutputSchema } from "../shared/ids";

export const SpaceArchiveInputSchema = z
  .object({
    space_id: SpaceIdInputSchema,
  })
  .strict();

export const SpaceArchiveOutputSchema = z.object({
  space_id: SpaceIdOutputSchema,
  deleted_at: z.number(),
});

export type SpaceArchiveWireInput = z.input<typeof SpaceArchiveInputSchema>;
export type SpaceArchiveInput = z.output<typeof SpaceArchiveInputSchema>;
export type SpaceArchiveOutput = z.output<typeof SpaceArchiveOutputSchema>;
