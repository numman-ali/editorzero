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
 * The response pins the published post-state structurally (ADR 0040
 * Step 5 — publish is orthogonal to `access_mode`): `published_slug` /
 * `published_at` are non-nullable here because the capability's entire
 * purpose is to land on the published state — a tighter contract than
 * the nullable read-path pair on `doc.get`/`doc.list`, deliberately not
 * shared with them. `render_version` is the F5 cache-invalidation
 * counter (renamed from `visibility_version` at the Step-5 split).
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
  published_slug: z.string(),
  published_at: z.number(),
  render_version: z.number(),
});

export type DocPublishWireInput = z.input<typeof DocPublishInputSchema>;
export type DocPublishInput = z.output<typeof DocPublishInputSchema>;
export type DocPublishOutput = z.output<typeof DocPublishOutputSchema>;
