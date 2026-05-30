/**
 * `collection.list` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`CollectionListInputSchema`); types are PascalCase named from the
 * capability contract:
 *   - `CollectionListWireInput`  = `z.input<CollectionListInputSchema>`  (wire request)
 *   - `CollectionListInput`      = `z.output<CollectionListInputSchema>` (branded handler input)
 *   - `CollectionListOutput`     = `z.output<CollectionListOutputSchema>` (branded response)
 * The reserved `CollectionListWireOutput` (= `z.input<CollectionListOutputSchema>`)
 * is added under that name only if a consumer needs the response-wire side.
 *
 * Input is the empty object (`.strict()` rejects unknown keys); a future
 * cursor / per-parent filter lands here without a breaking shape change.
 * Output is the "list-view ergonomics" shape (id, title, slug, parent_id,
 * timestamps) shared with `doc.list`: branded `id`/`parent_id` come from
 * `../shared/ids` (plain `string` on the wire, branded for in-process `hc`
 * consumers per ADR 0033), the rest are primitives.
 */

import { z } from "zod";

import { CollectionIdOutputSchema } from "../shared/ids";

export const CollectionListInputSchema = z.object({}).strict();

const CollectionSummarySchema = z.object({
  id: CollectionIdOutputSchema,
  title: z.string(),
  slug: z.string(),
  parent_id: CollectionIdOutputSchema.nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const CollectionListOutputSchema = z.object({
  collections: z.array(CollectionSummarySchema),
});

export type CollectionListWireInput = z.input<typeof CollectionListInputSchema>;
export type CollectionListInput = z.output<typeof CollectionListInputSchema>;
export type CollectionListOutput = z.output<typeof CollectionListOutputSchema>;
