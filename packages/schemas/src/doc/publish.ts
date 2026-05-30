/**
 * `doc.publish` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocPublishInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocPublishWireInput`  = `z.input<DocPublishInputSchema>`   (wire request)
 *   - `DocPublishInput`      = `z.output<DocPublishInputSchema>`  (branded handler input)
 *   - `DocPublishOutput`     = `z.output<DocPublishOutputSchema>` (branded response)
 *   - `DocPublishWireOutput` = `z.input<DocPublishOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocPublishWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocPublishInput, DocPublishOutput>`;
 * the route feeds `DocPublishInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocPublishOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * `visibility` is a literal `"public"` (NOT the shared `DocVisibility`
 * enum): the capability's entire purpose is to land on that one state, so
 * the response pins it via `z.literal(...)` — a tighter contract than the
 * enum, which must not be widened by sharing it (see the capability
 * header and `../shared/visibility`).
 */

import { z } from "zod";

import { DocIdInputSchema, DocIdOutputSchema } from "../shared/ids";

export const DocPublishInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
  })
  .strict();

export const DocPublishOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  visibility: z.literal("public"),
  visibility_version: z.number(),
  published_at: z.number(),
});

export type DocPublishWireInput = z.input<typeof DocPublishInputSchema>;
export type DocPublishInput = z.output<typeof DocPublishInputSchema>;
export type DocPublishOutput = z.output<typeof DocPublishOutputSchema>;
