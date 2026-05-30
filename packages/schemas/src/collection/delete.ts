/**
 * `collection.delete` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`CollectionDeleteInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `CollectionDeleteWireInput`  = `z.input<CollectionDeleteInputSchema>`   (wire request)
 *   - `CollectionDeleteInput`      = `z.output<CollectionDeleteInputSchema>`  (branded handler input)
 *   - `CollectionDeleteOutput`     = `z.output<CollectionDeleteOutputSchema>` (branded response)
 *   - `CollectionDeleteWireOutput` = `z.input<CollectionDeleteOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `CollectionDeleteWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<CollectionDeleteInput,
 * CollectionDeleteOutput>`; the route feeds `CollectionDeleteInputSchema`
 * to `validator` (→ wire-typed `hc` client, branded `c.req.valid`) and
 * `CollectionDeleteOutputSchema` to `resolver` + `.parse(result)`.
 *
 * Branded-ID fields come from `../shared/ids`; `deleted_at` is the epoch-ms
 * stamp the handler writes to `collections.deleted_at`.
 */

import { z } from "zod";

import { CollectionIdInputSchema, CollectionIdOutputSchema } from "../shared/ids";

export const CollectionDeleteInputSchema = z
  .object({
    collection_id: CollectionIdInputSchema,
  })
  .strict();

export const CollectionDeleteOutputSchema = z.object({
  collection_id: CollectionIdOutputSchema,
  deleted_at: z.number(),
});

export type CollectionDeleteWireInput = z.input<typeof CollectionDeleteInputSchema>;
export type CollectionDeleteInput = z.output<typeof CollectionDeleteInputSchema>;
export type CollectionDeleteOutput = z.output<typeof CollectionDeleteOutputSchema>;
