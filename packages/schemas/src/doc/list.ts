/**
 * `doc.list` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocListInputSchema`); types are PascalCase named from the
 * capability contract:
 *   - `DocListWireInput` = `z.input<DocListInputSchema>`   (wire request)
 *   - `DocListInput`     = `z.output<DocListInputSchema>`  (branded handler input)
 *   - `DocListOutput`    = `z.output<DocListOutputSchema>` (branded response)
 * `DocListWireOutput` (`z.input<DocListOutputSchema>`) is the reserved
 * name for the response-wire side — add it under that name only if a
 * consumer needs it.
 *
 * The input is empty (`z.object({}).strict()`) — `doc.list` takes no
 * arguments in v1, and `.strict()` makes any caller-supplied field a
 * `unrecognized_keys` 400 rather than a silent drop. The output IDs are
 * re-branded via the shared `*OutputSchema` transforms so
 * `z.output<typeof DocListOutputSchema>` preserves the brand — callers
 * (API adapter / CLI / MCP) receive typed IDs instead of plain strings
 * without a cast at the boundary. `access_mode` is the read-path
 * tri-state (`DocVisibilitySchema`): the list echoes whichever value a
 * doc currently holds.
 */

import { z } from "zod";
import { AccessModeSchema } from "../shared/grant";
import { CollectionIdOutputSchema, DocIdOutputSchema } from "../shared/ids";

export const DocListInputSchema = z.object({}).strict();

// Fields chosen for the "list view" use case: enough to render a
// navigable document list (id, title, access_mode + publish state, collection,
// timestamps). Internal columns (`order_key`, `render_version`,
// `deleted_at`, `workspace_id`) are intentionally omitted — the
// scope is implicit; the ordering is applied inside the handler.
const DocSummarySchema = z.object({
  id: DocIdOutputSchema,
  title: z.string(),
  slug: z.string(),
  collection_id: CollectionIdOutputSchema.nullable(),
  access_mode: AccessModeSchema,
  published_slug: z.string().nullable(),
  published_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const DocListOutputSchema = z.object({
  docs: z.array(DocSummarySchema),
});

export type DocListWireInput = z.input<typeof DocListInputSchema>;
export type DocListInput = z.output<typeof DocListInputSchema>;
export type DocListOutput = z.output<typeof DocListOutputSchema>;
