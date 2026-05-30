/**
 * `collection.restore` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`CollectionRestoreInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `CollectionRestoreWireInput`  = `z.input<CollectionRestoreInputSchema>`   (wire request)
 *   - `CollectionRestoreInput`      = `z.output<CollectionRestoreInputSchema>`  (branded handler input)
 *   - `CollectionRestoreOutput`     = `z.output<CollectionRestoreOutputSchema>` (branded response)
 *   - `CollectionRestoreWireOutput` = `z.input<CollectionRestoreOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `CollectionRestoreWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<CollectionRestoreInput,
 * CollectionRestoreOutput>`; the route feeds `CollectionRestoreInputSchema`
 * to `validator` (→ wire-typed `hc` client, branded `c.req.valid`) and
 * `CollectionRestoreOutputSchema` to `resolver` + `.parse(result)`.
 *
 * Branded-ID fields come from `../shared/ids`. The `collection_id` request
 * field validates the UUIDv7 shape on the wire (generic "must be a UUIDv7"
 * message — the zod issue `path` identifies the field) and narrows to the
 * `CollectionId` brand.
 */

import { z } from "zod";

import { CollectionIdInputSchema, CollectionIdOutputSchema } from "../shared/ids";

export const CollectionRestoreInputSchema = z
  .object({
    collection_id: CollectionIdInputSchema,
  })
  .strict();

export const CollectionRestoreOutputSchema = z.object({
  collection_id: CollectionIdOutputSchema,
});

export type CollectionRestoreWireInput = z.input<typeof CollectionRestoreInputSchema>;
export type CollectionRestoreInput = z.output<typeof CollectionRestoreInputSchema>;
export type CollectionRestoreOutput = z.output<typeof CollectionRestoreOutputSchema>;
