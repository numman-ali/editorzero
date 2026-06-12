/**
 * `space.update` wire + internal contract (ADR 0034, ADR 0040 Step 8).
 *
 * Patch fields are the mutable subset the Step-7 effect carries —
 * `{name, slug, space_type, baseline_access}`: `kind` is structural
 * (team↔personal is a different entity, not an edit) and
 * `owner_user_id` is pinned by the personal-space CHECK, so neither is
 * patchable. Every field optional + an at-least-one refine (the
 * `workspace.update` posture); `.strict()` rejects unknown keys before
 * the refine runs.
 *
 * PERSONAL spaces additionally refuse `space_type`/`baseline_access`
 * patches AT THE HANDLER (the schema cannot see the row): a personal
 * space is structurally private — flipping its type would de-facto
 * convert the drafts home into a shared space without the kind change
 * the model requires. `name`/`slug` stay patchable (cosmetic).
 */

import { z } from "zod";

import { SpaceIdInputSchema } from "../shared/ids";
import { SpaceBaselineAccessSchema, SpaceRowOutputSchema, SpaceTypeSchema } from "../shared/space";

const SpaceUpdateBaseSchema = z
  .object({
    space_id: SpaceIdInputSchema,
    name: z.string().trim().min(1, "name must not be empty or whitespace-only").max(200).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be kebab-case (lowercase a-z, 0-9, hyphens)")
      .optional(),
    space_type: SpaceTypeSchema.optional(),
    baseline_access: SpaceBaselineAccessSchema.optional(),
  })
  .strict();

const atLeastOnePatchField = (v: {
  name?: string | undefined;
  slug?: string | undefined;
  space_type?: unknown;
  baseline_access?: unknown;
}) =>
  v.name !== undefined ||
  v.slug !== undefined ||
  v.space_type !== undefined ||
  v.baseline_access !== undefined;

const AT_LEAST_ONE = { message: "space.update requires at least one patch field" };

export const SpaceUpdateInputSchema = SpaceUpdateBaseSchema.refine(
  atLeastOnePatchField,
  AT_LEAST_ONE,
);

// Route-side request pieces (P3 — path param + JSON body merged into one
// capability input). Derived from the SAME base object — no restated
// field, and the body half re-applies the at-least-one refine.
export const SpaceUpdateParamSchema = SpaceUpdateBaseSchema.pick({ space_id: true });
export const SpaceUpdateBodySchema = SpaceUpdateBaseSchema.omit({ space_id: true }).refine(
  atLeastOnePatchField,
  AT_LEAST_ONE,
);

export type SpaceUpdateWireInput = z.input<typeof SpaceUpdateInputSchema>;
export type SpaceUpdateInput = z.output<typeof SpaceUpdateInputSchema>;

export const SpaceUpdateOutputSchema = SpaceRowOutputSchema;
export type SpaceUpdateOutput = z.output<typeof SpaceUpdateOutputSchema>;
