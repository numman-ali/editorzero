/**
 * `collection.move` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`CollectionMoveInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `CollectionMoveWireInput`  = `z.input<CollectionMoveInputSchema>`   (wire request)
 *   - `CollectionMoveInput`      = `z.output<CollectionMoveInputSchema>`  (branded handler input)
 *   - `CollectionMoveOutput`     = `z.output<CollectionMoveOutputSchema>` (branded response)
 *   - `CollectionMoveWireOutput` = `z.input<CollectionMoveOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `CollectionMoveWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<CollectionMoveInput,
 * CollectionMoveOutput>`; the route feeds `CollectionMoveInputSchema` to
 * `validator` (→ wire-typed `hc` client, branded `c.req.valid`) and
 * `CollectionMoveOutputSchema` to `resolver` + `.parse(result)`.
 *
 * Branded-ID fields come from `../shared/ids`. `new_parent_id` is
 * `.nullable()` ONLY (NOT `.optional()`): `null` (explicit workspace root)
 * must be distinct from "missing" on the wire — move is an explicit
 * operation, and "omit to default to current parent" would make the common
 * mistake (forgetting the field) a silent no-op (see the capability header).
 */

import { z } from "zod";

import {
  CollectionIdInputSchema,
  CollectionIdOutputSchema,
  SpaceIdOutputSchema,
} from "../shared/ids";

export const CollectionMoveInputSchema = z
  .object({
    collection_id: CollectionIdInputSchema,
    // `null` (explicit workspace root) must be distinct from "missing"
    // on the wire so the caller can unambiguously request root-parent.
    // `.optional()` is rejected — move is an explicit operation, and
    // "omit to default to current parent" would make the common mistake
    // (forgetting the field) a silent no-op.
    new_parent_id: CollectionIdInputSchema.nullable(),
  })
  .strict();

export const CollectionMoveOutputSchema = z.object({
  collection_id: CollectionIdOutputSchema,
  new_parent_id: CollectionIdOutputSchema.nullable(),
  new_order_key: z.string(),
  // Post-move space binding (`null` = legacy no-space bucket; ADR 0040
  // Step 7). The shipped handler never rewrites the binding, so this
  // echoes the row's current value; Step-8 cross-space moves change it.
  new_space_id: SpaceIdOutputSchema.nullable(),
  updated_at: z.number(),
});

export type CollectionMoveWireInput = z.input<typeof CollectionMoveInputSchema>;
export type CollectionMoveInput = z.output<typeof CollectionMoveInputSchema>;
export type CollectionMoveOutput = z.output<typeof CollectionMoveOutputSchema>;
