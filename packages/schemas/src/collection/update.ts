/**
 * `collection.update` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`CollectionUpdateInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `CollectionUpdateWireInput`  = `z.input<CollectionUpdateInputSchema>`   (wire request)
 *   - `CollectionUpdateInput`      = `z.output<CollectionUpdateInputSchema>`  (branded handler input)
 *   - `CollectionUpdateOutput`     = `z.output<CollectionUpdateOutputSchema>` (branded response)
 *   - `CollectionUpdateWireOutput` = `z.input<CollectionUpdateOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `CollectionUpdateWireOutput`
 * is the reserved name for the response-wire side — add it under that name
 * (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<CollectionUpdateInput,
 * CollectionUpdateOutput>`; the route feeds `CollectionUpdateInputSchema`
 * to `validator` (→ wire-typed `hc` client, branded `c.req.valid`) and
 * `CollectionUpdateOutputSchema` to `resolver` + `.parse(result)`.
 *
 * v1 mutable surface is `title` only; `slug` is derived from `title` in the
 * handler (see the capability header). `collection_id` validates the UUIDv7
 * shape on input and narrows to the brand; the output echoes the post-state
 * (`title` / `slug` / `updated_at`). The shared `TitleSchema`
 * (`.trim().min(1)`) closes the visually-blank-title hole.
 */

import { z } from "zod";

import { TitleSchema } from "../shared/fields";
import { CollectionIdInputSchema, CollectionIdOutputSchema } from "../shared/ids";

export const CollectionUpdateInputSchema = z
  .object({
    collection_id: CollectionIdInputSchema,
    // Same `.trim().min(1)` posture as `collection.create` + `doc.rename`:
    // closes the "visually blank title" hole (`"   "` trims to `""`).
    title: TitleSchema,
  })
  .strict();

export const CollectionUpdateOutputSchema = z.object({
  collection_id: CollectionIdOutputSchema,
  title: z.string(),
  slug: z.string(),
  updated_at: z.number(),
});

export type CollectionUpdateWireInput = z.input<typeof CollectionUpdateInputSchema>;
export type CollectionUpdateInput = z.output<typeof CollectionUpdateInputSchema>;
export type CollectionUpdateOutput = z.output<typeof CollectionUpdateOutputSchema>;
