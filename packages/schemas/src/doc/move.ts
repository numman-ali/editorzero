/**
 * `doc.move` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocMoveInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocMoveWireInput`  = `z.input<DocMoveInputSchema>`   (wire request)
 *   - `DocMoveInput`      = `z.output<DocMoveInputSchema>`  (branded handler input)
 *   - `DocMoveOutput`     = `z.output<DocMoveOutputSchema>` (branded response)
 *   - `DocMoveWireOutput` = `z.input<DocMoveOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocMoveWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocMoveInput, DocMoveOutput>`;
 * the route feeds `DocMoveInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocMoveOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * **`new_collection_id` is `.nullable()` only, never `.optional()`** —
 * a move is explicit, so `null` (workspace root) must be distinct from
 * "missing" on the wire; the capability rejects an omitted key via
 * `.strict()`. Branded-ID fields come from `../shared/ids`; the
 * nullable response field is `CollectionIdOutputSchema.nullable()`,
 * which composes the same `string | null → CollectionId | null`
 * narrowing the capability hand-rolled inline.
 */

import { z } from "zod";

import {
  CollectionIdInputSchema,
  CollectionIdOutputSchema,
  DocIdInputSchema,
  DocIdOutputSchema,
} from "../shared/ids";

export const DocMoveInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
    // `null` (explicit workspace root) must be distinct from "missing"
    // on the wire. `.optional()` rejected for the same reason
    // `collection.move` rejects it — move is explicit.
    new_collection_id: CollectionIdInputSchema.nullable(),
  })
  .strict();

export const DocMoveOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  new_collection_id: CollectionIdOutputSchema.nullable(),
  new_order_key: z.string(),
  updated_at: z.number(),
});

export type DocMoveWireInput = z.input<typeof DocMoveInputSchema>;
export type DocMoveInput = z.output<typeof DocMoveInputSchema>;
export type DocMoveOutput = z.output<typeof DocMoveOutputSchema>;
