/**
 * `doc.move` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocMoveInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocMoveWireInput`  = `z.input<DocMoveInputSchema>`   (wire request)
 *   - `DocMoveInput`      = `z.output<DocMoveInputSchema>`  (branded handler input)
 *   - `DocMoveOutput`     = `z.output<DocMoveOutputSchema>` (branded response)
 *   - `DocMoveWireOutput` = `z.input<DocMoveOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocMoveWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocMoveInput, DocMoveOutput>`;
 * the route feeds `DocMoveInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocMoveOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * **`new_collection_id` is `.nullable()` only, never `.optional()`** —
 * a move is explicit, so `null` (workspace root) must be distinct from
 * "missing" on the wire; the capability rejects an omitted key via
 * `.strict()`. Branded-ID fields come from `../shared/ids`; the
 * nullable response field is `CollectionIdOutputSchema.nullable()`,
 * which composes the same `string | null → CollectionId | null`
 * narrowing the capability hand-rolled inline.
 *
 * **`acl_policy` is `.optional()`, conditionally REQUIRED by the
 * handler (ADR 0040 §7, Step-8 cross-boundary branch).** A move that
 * crosses the doc's space-bucket boundary is an ACL transition and
 * must carry the caller's explicit choice (`adopt_baseline` — shed
 * every doc-scoped grant, guest edges included — or `keep_grants`);
 * absent on a crossing → typed 400 (`acl_transition_policy_required`,
 * the "never silent" prompt contract enforced server-side so every
 * surface inherits it). Present on a SAME-bucket move → typed 400 too
 * (`acl_policy_not_applicable` — accepting-and-ignoring would let the
 * caller believe a transition happened). Zod cannot express the
 * conditionality (it depends on stored placement); the handler owns it.
 *
 * **`acl_transition` on the output** echoes the applied transition on
 * a crossing (absent on same-bucket): the policy, both resolved space
 * bindings, and the FULL preimage of every dropped grant row — the
 * effect projects from this echo, and the caller gets the offboarding
 * receipt (the `permission.revoke` echo posture; rows are hard-deleted).
 */

import { z } from "zod";

import { AclTransitionOutputSchema, AclTransitionPolicySchema } from "../shared/grant";
import {
  CollectionIdInputSchema,
  CollectionIdOutputSchema,
  DocIdInputSchema,
  DocIdOutputSchema,
} from "../shared/ids";

// Re-exported for existing importers; the definition moved to
// `../shared/grant` when `collection.move` grew the same crossing branch
// (one transition vocabulary, two movers — SSOT).
export { AclTransitionPolicySchema };

export const DocMoveInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
    // `null` (explicit workspace root) must be distinct from "missing"
    // on the wire. `.optional()` rejected for the same reason
    // `collection.move` rejects it — move is explicit.
    new_collection_id: CollectionIdInputSchema.nullable(),
    acl_policy: AclTransitionPolicySchema.optional(),
  })
  .strict();

export const DocMoveOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  new_collection_id: CollectionIdOutputSchema.nullable(),
  new_order_key: z.string(),
  updated_at: z.number(),
  acl_transition: AclTransitionOutputSchema.optional(),
});

export type DocMoveWireInput = z.input<typeof DocMoveInputSchema>;
export type DocMoveInput = z.output<typeof DocMoveInputSchema>;
export type DocMoveOutput = z.output<typeof DocMoveOutputSchema>;
