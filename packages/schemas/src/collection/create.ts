/**
 * `collection.create` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`CollectionCreateInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `CollectionCreateWireInput`  = `z.input<CollectionCreateInputSchema>`   (wire request)
 *   - `CollectionCreateInput`      = `z.output<CollectionCreateInputSchema>`  (branded handler input)
 *   - `CollectionCreateOutput`     = `z.output<CollectionCreateOutputSchema>` (branded response)
 *   - `CollectionCreateWireOutput` = `z.input<CollectionCreateOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `CollectionCreateWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<CollectionCreateInput,
 * CollectionCreateOutput>`; the route feeds `CollectionCreateInputSchema`
 * to `validator` (→ wire-typed `hc` client, branded `c.req.valid`) and
 * `CollectionCreateOutputSchema` to `resolver` + `.parse(result)`.
 *
 * Branded-ID fields come from `../shared/ids`; the shared `TitleSchema`
 * (`../shared/fields`) carries the trim-then-`min(1)` rule. `parent_id`
 * is `null` (explicit workspace root) or omitted (also root) on the wire;
 * the capability semantics that shape these are documented in the
 * capability header (`@editorzero/capabilities/collection/create`).
 */

import { z } from "zod";

import { TitleSchema } from "../shared/fields";
import {
  CollectionIdInputSchema,
  CollectionIdOutputSchema,
  UserIdOutputSchema,
  WorkspaceIdOutputSchema,
} from "../shared/ids";

export const CollectionCreateInputSchema = z
  .object({
    // `.trim()` then `.min(1)` — a whitespace-only title trims to "" and
    // fails, closing the visually-blank-title hole.
    title: TitleSchema,
    // `null` (explicit workspace root) is distinct from "omitted" on the
    // wire; both coerce to null in the handler.
    parent_id: CollectionIdInputSchema.nullable().optional(),
  })
  .strict();

export const CollectionCreateOutputSchema = z.object({
  collection_id: CollectionIdOutputSchema,
  workspace_id: WorkspaceIdOutputSchema,
  parent_id: CollectionIdOutputSchema.nullable(),
  title: z.string(),
  slug: z.string(),
  order_key: z.string(),
  // Carried on the response so the `collection.create` audit effect records
  // the handler-resolved attribution (the human behind an agent — see the
  // capability's `resolveCreatedBy`), not the envelope principal. Invariant
  // 3a reconstructs `created_by` from this field, never from the audit row's
  // `principal_id` (Codex contract review HIGH 1).
  created_by: UserIdOutputSchema,
});

export type CollectionCreateWireInput = z.input<typeof CollectionCreateInputSchema>;
export type CollectionCreateInput = z.output<typeof CollectionCreateInputSchema>;
export type CollectionCreateOutput = z.output<typeof CollectionCreateOutputSchema>;
