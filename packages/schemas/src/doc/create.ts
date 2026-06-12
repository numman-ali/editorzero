/**
 * `doc.create` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocCreateInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocCreateWireInput`  = `z.input<DocCreateInputSchema>`   (wire request)
 *   - `DocCreateInput`      = `z.output<DocCreateInputSchema>`  (branded handler input)
 *   - `DocCreateOutput`     = `z.output<DocCreateOutputSchema>` (branded response)
 *   - `DocCreateWireOutput` = `z.input<DocCreateOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocCreateWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocCreateInput, DocCreateOutput>`;
 * the route feeds `DocCreateInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocCreateOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * **Golden reference for schema extraction.** Branded-ID fields come
 * from `../shared/ids`; capability-specific shapes (the seed-block) stay
 * local. `access_mode` echoes the create-time default (`"space"`) via the
 * shared `AccessModeSchema` — it is NOT caller-settable (the mode switch
 * is a Step-8 ACL capability; see the capability header). A new doc is
 * never born published, so `published_slug`/`published_at` are pinned
 * `null` literals on the response.
 */

import { z } from "zod";
import { AccessModeSchema } from "../shared/grant";
import {
  BlockIdOutputSchema,
  CollectionIdInputSchema,
  CollectionIdOutputSchema,
  DocIdOutputSchema,
  UserIdOutputSchema,
  WorkspaceIdOutputSchema,
} from "../shared/ids";

export const DocCreateInputSchema = z
  .object({
    // `.trim()` then `.min(1)` — a whitespace-only title trims to "" and
    // fails, closing the visually-blank-title hole.
    title: z.string().trim().min(1, "title must not be empty or whitespace-only"),
    // `null` (explicit workspace root) is distinct from "omitted" on the
    // wire; both coerce to null in the handler.
    collection_id: CollectionIdInputSchema.nullable().optional(),
  })
  .strict();

const SeedBlockSchema = z.object({
  id: BlockIdOutputSchema,
  type: z.string(),
  props: z.record(z.string(), z.unknown()).optional(),
  content: z.unknown().optional(),
});

export const DocCreateOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  workspace_id: WorkspaceIdOutputSchema,
  collection_id: CollectionIdOutputSchema.nullable(),
  title: z.string(),
  slug: z.string(),
  order_key: z.string(),
  // Carried on the response so the `doc.create` audit effect records the
  // handler-resolved attribution (the human behind an agent — see the
  // capability's `resolveCreatedBy`), not the envelope principal. Invariant
  // 3a reconstructs `created_by` from this field, never from the audit row's
  // `principal_id` — which for an agent write is the agent, not the human
  // (Codex contract review HIGH 1).
  created_by: UserIdOutputSchema,
  access_mode: AccessModeSchema,
  published_slug: z.null(),
  published_at: z.null(),
  seed_blocks: z.array(SeedBlockSchema),
});

export type DocCreateWireInput = z.input<typeof DocCreateInputSchema>;
export type DocCreateInput = z.output<typeof DocCreateInputSchema>;
export type DocCreateOutput = z.output<typeof DocCreateOutputSchema>;
