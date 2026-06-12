/**
 * `doc.restore` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocRestoreInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocRestoreWireInput`  = `z.input<DocRestoreInputSchema>`   (wire request)
 *   - `DocRestoreInput`      = `z.output<DocRestoreInputSchema>`  (branded handler input)
 *   - `DocRestoreOutput`     = `z.output<DocRestoreOutputSchema>` (branded response)
 *   - `DocRestoreWireOutput` = `z.input<DocRestoreOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocRestoreWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocRestoreInput, DocRestoreOutput>`;
 * the route feeds `DocRestoreInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocRestoreOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * **Shape.** Mirror of `doc.delete`: a single `doc_id` in, a `doc_id`
 * plus `render_version` out. `doc_id` validates as UUIDv7 on the
 * wire (`DocIdInputSchema`) and narrows to the brand. The output carries
 * `render_version` so the caller can swap their cached public-route
 * key after a restore flips the route from "404" back to "renders"; no
 * `restored_at` field — the post-state is "not deleted" and the audit
 * row owns the event timestamp (see the capability header).
 */

import { z } from "zod";

import { DocIdInputSchema, DocIdOutputSchema } from "../shared/ids";

export const DocRestoreInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
  })
  .strict();

export const DocRestoreOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  render_version: z.number(),
});

export type DocRestoreWireInput = z.input<typeof DocRestoreInputSchema>;
export type DocRestoreInput = z.output<typeof DocRestoreInputSchema>;
export type DocRestoreOutput = z.output<typeof DocRestoreOutputSchema>;
