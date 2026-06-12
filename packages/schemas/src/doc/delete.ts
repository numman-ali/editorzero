/**
 * `doc.delete` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocDeleteInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocDeleteWireInput`  = `z.input<DocDeleteInputSchema>`   (wire request)
 *   - `DocDeleteInput`      = `z.output<DocDeleteInputSchema>`  (branded handler input)
 *   - `DocDeleteOutput`     = `z.output<DocDeleteOutputSchema>` (branded response)
 *   - `DocDeleteWireOutput` = `z.input<DocDeleteOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocDeleteWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocDeleteInput, DocDeleteOutput>`;
 * the route feeds `DocDeleteInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocDeleteOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * Branded-ID fields come from `../shared/ids` (`DocIdInputSchema`
 * validates the UUIDv7 shape then brands; `DocIdOutputSchema` brands a
 * trusted server-produced string). `deleted_at` / `render_version`
 * are plain epoch-millis / counter numbers; `deleted_at` is the exact
 * stamp the handler wrote to `docs.deleted_at` and is echoed onto the
 * `doc.soft_delete` audit effect so replay reconstructs the ADR 0017
 * recovery anchor precisely (see the capability header).
 */

import { z } from "zod";

import { DocIdInputSchema, DocIdOutputSchema } from "../shared/ids";

export const DocDeleteInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
  })
  .strict();

export const DocDeleteOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  deleted_at: z.number(),
  render_version: z.number(),
});

export type DocDeleteWireInput = z.input<typeof DocDeleteInputSchema>;
export type DocDeleteInput = z.output<typeof DocDeleteInputSchema>;
export type DocDeleteOutput = z.output<typeof DocDeleteOutputSchema>;
