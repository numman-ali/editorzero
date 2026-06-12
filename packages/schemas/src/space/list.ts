/**
 * `space.list` wire + internal contract (ADR 0034, ADR 0040 Step 8).
 *
 * Empty strict input (the `doc.list` posture — no arguments in v1;
 * `.strict()` turns any caller-supplied field into an
 * `unrecognized_keys` 400 rather than a silent drop). Deliberately
 * UNPAGINATED: spaces are org structure — tens, not thousands — and
 * the visibility filter is a resolver predicate (open-space baseline ∨
 * membership ∨ grant ∨ administer), not SQL, so a cursor would page
 * over rows the caller can't see. An optional cursor input is an
 * additive change if scale ever demands it.
 *
 * Output rows are `SpaceRowOutputSchema` verbatim — the ONE space row
 * shape (see `../shared/space`).
 */

import { z } from "zod";

import { SpaceRowOutputSchema } from "../shared/space";

export const SpaceListInputSchema = z.object({}).strict();

export const SpaceListOutputSchema = z.object({
  spaces: z.array(SpaceRowOutputSchema),
});

export type SpaceListWireInput = z.input<typeof SpaceListInputSchema>;
export type SpaceListInput = z.output<typeof SpaceListInputSchema>;
export type SpaceListOutput = z.output<typeof SpaceListOutputSchema>;
