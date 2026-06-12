/**
 * `space.get` wire + internal contract (ADR 0034, ADR 0040 Step 8).
 *
 * Param-only input (the `doc.get` P2 shape — the input schema IS the
 * route's param validator). Output is `SpaceRowOutputSchema` verbatim —
 * the ONE space row shape every `space.*` verb echoes; a read restates
 * nothing. `deleted_at` is structurally `null` here (the read posture
 * is trash-invisible — a trashed space 404s), but the field stays in
 * the shape per the shared-schema design: same column, same shape, no
 * per-verb variant.
 */

import { z } from "zod";

import { SpaceIdInputSchema } from "../shared/ids";
import { SpaceRowOutputSchema } from "../shared/space";

export const SpaceGetInputSchema = z
  .object({
    space_id: SpaceIdInputSchema,
  })
  .strict();

export const SpaceGetOutputSchema = SpaceRowOutputSchema;

export type SpaceGetWireInput = z.input<typeof SpaceGetInputSchema>;
export type SpaceGetInput = z.output<typeof SpaceGetInputSchema>;
export type SpaceGetOutput = z.output<typeof SpaceGetOutputSchema>;
