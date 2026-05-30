/**
 * `doc.unpublish` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocUnpublishInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocUnpublishWireInput`  = `z.input<DocUnpublishInputSchema>`   (wire request)
 *   - `DocUnpublishInput`      = `z.output<DocUnpublishInputSchema>`  (branded handler input)
 *   - `DocUnpublishOutput`     = `z.output<DocUnpublishOutputSchema>` (branded response)
 *   - `DocUnpublishWireOutput` = `z.input<DocUnpublishOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocUnpublishWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocUnpublishInput, DocUnpublishOutput>`;
 * the route feeds `DocUnpublishInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocUnpublishOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * `visibility` is a literal `"workspace"` (NOT the shared `DocVisibility`
 * enum): the capability's entire purpose is to land on that one state, so
 * the response pins it via `z.literal(...)` — a tighter contract than the
 * enum, which must not be widened by sharing it (see the capability
 * header and `../shared/visibility`). No `published_at` field: the
 * un-publish side has no symmetric `unpublished_at` in the target DDL.
 */

import { z } from "zod";

import { DocIdInputSchema, DocIdOutputSchema } from "../shared/ids";

export const DocUnpublishInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
  })
  .strict();

export const DocUnpublishOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  visibility: z.literal("workspace"),
  visibility_version: z.number(),
});

export type DocUnpublishWireInput = z.input<typeof DocUnpublishInputSchema>;
export type DocUnpublishInput = z.output<typeof DocUnpublishInputSchema>;
export type DocUnpublishOutput = z.output<typeof DocUnpublishOutputSchema>;
