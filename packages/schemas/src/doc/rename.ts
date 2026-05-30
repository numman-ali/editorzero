/**
 * `doc.rename` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocRenameInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocRenameWireInput`  = `z.input<DocRenameInputSchema>`   (wire request)
 *   - `DocRenameInput`      = `z.output<DocRenameInputSchema>`  (branded handler input)
 *   - `DocRenameOutput`     = `z.output<DocRenameOutputSchema>` (branded response)
 *   - `DocRenameWireOutput` = `z.input<DocRenameOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocRenameWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocRenameInput, DocRenameOutput>`;
 * the route feeds `DocRenameInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocRenameOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * The `doc_id` field on the input validates the UUIDv7 shape so a
 * malformed id is a clean 400 before the handler runs; `title` shares
 * the trim-then-`min(1)` `TitleSchema` (closes the visually-blank-title
 * hole). The output returns the post-rename projection (incl.
 * `updated_at`, which row-side stale checks key on).
 */

import { z } from "zod";

import { TitleSchema } from "../shared/fields";
import { DocIdInputSchema, DocIdOutputSchema } from "../shared/ids";

export const DocRenameInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
    title: TitleSchema,
  })
  .strict();

export const DocRenameOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  title: z.string(),
  slug: z.string(),
  updated_at: z.number(),
});

export type DocRenameWireInput = z.input<typeof DocRenameInputSchema>;
export type DocRenameInput = z.output<typeof DocRenameInputSchema>;
export type DocRenameOutput = z.output<typeof DocRenameOutputSchema>;
