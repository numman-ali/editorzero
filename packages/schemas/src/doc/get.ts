/**
 * `doc.get` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocGetInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocGetWireInput`  = `z.input<DocGetInputSchema>`   (wire request)
 *   - `DocGetInput`      = `z.output<DocGetInputSchema>`  (branded handler input)
 *   - `DocGetOutput`     = `z.output<DocGetOutputSchema>` (branded response)
 *   - `DocGetWireOutput` = `z.input<DocGetOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocGetWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocGetInput, DocGetOutput>`; the
 * route feeds `DocGetInputSchema` to `validator` (→ wire-typed `hc`
 * client, branded `c.req.valid`) and `DocGetOutputSchema` to `resolver`
 * + `.parse(result)`.
 *
 * **Branded-ID fields come from `../shared/ids`; `access_mode` from
 * `../shared/grant` (the ADR 0040 Step-5 read-scope enum); the publish
 * dimension rides `published_slug`/`published_at` (null ⇔ unpublished).** `blocks` is intentionally `z.array(z.unknown())`,
 * NOT the owned `Block` shape: expressing that polymorphic shape in
 * zod would mirror the block-type registry here, and a schemas leaf
 * must stay light. The capability handler returns the canonical
 * `Block[]` from `@editorzero/blocks` (assignable to `unknown[]`);
 * `@editorzero/sync`'s `readBlocks` owns the runtime block contract,
 * so the dispatcher's output-parse is a structural pass-through for
 * this field.
 */

import { z } from "zod";
import { AccessModeSchema } from "../shared/grant";
import {
  CollectionIdOutputSchema,
  DocIdInputSchema,
  DocIdOutputSchema,
  WorkspaceIdOutputSchema,
} from "../shared/ids";

export const DocGetInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
  })
  .strict();

const DocMetaSchema = z.object({
  id: DocIdOutputSchema,
  workspace_id: WorkspaceIdOutputSchema,
  title: z.string(),
  slug: z.string(),
  collection_id: CollectionIdOutputSchema.nullable(),
  access_mode: AccessModeSchema,
  published_slug: z.string().nullable(),
  published_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const DocGetOutputSchema = z.object({
  doc: DocMetaSchema,
  blocks: z.array(z.unknown()),
});

export type DocGetWireInput = z.input<typeof DocGetInputSchema>;
export type DocGetInput = z.output<typeof DocGetInputSchema>;
export type DocGetOutput = z.output<typeof DocGetOutputSchema>;
