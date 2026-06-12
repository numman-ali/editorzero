/**
 * `collection.move` wire + internal contract (ADR 0034) — the single
 * source the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`CollectionMoveInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `CollectionMoveWireInput`  = `z.input<CollectionMoveInputSchema>`   (wire request)
 *   - `CollectionMoveInput`      = `z.output<CollectionMoveInputSchema>`  (branded handler input)
 *   - `CollectionMoveOutput`     = `z.output<CollectionMoveOutputSchema>` (branded response)
 *   - `CollectionMoveWireOutput` = `z.input<CollectionMoveOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `CollectionMoveWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * **`destination` is a tagged union, not a nullable parent id (ADR 0040
 * space-collection crossing slice).** The old `new_parent_id:
 * CollectionId | null` could not express "root of space S" — `null`
 * collapsed two distinct destinations (legacy root, space root) into
 * one, and a create-style `{ new_parent_id, space_id }` pair would need
 * a both-set refine rail. The union makes illegal states
 * unrepresentable and names each destination for surface copy:
 *   - `{ kind: "legacy_root" }`               — workspace root, no-space bucket
 *   - `{ kind: "space_root", space_id }`      — root level of a space
 *   - `{ kind: "collection", collection_id }` — under an existing collection
 * Each arm is `.strict()` so a stray `space_id` on a `collection` arm is
 * a 400, not silently ignored. This was a pre-1.0 breaking reshape — all
 * callers are in-repo and moved in the same commit.
 *
 * **`acl_policy` is `.optional()`, conditionally REQUIRED by the handler
 * (ADR 0040 §7).** A move whose destination bucket differs from the
 * source bucket is an ACL transition for EVERY doc in the moved subtree
 * and must carry the caller's explicit choice (`adopt_baseline` /
 * `keep_grants` — vocabulary shared with `doc.move` via
 * `../shared/grant`); absent on a crossing → typed 400
 * (`acl_transition_policy_required`), present on a same-bucket move →
 * typed 400 (`acl_policy_not_applicable`). Zod cannot express the
 * conditionality (it depends on stored placement); the handler owns it.
 *
 * **`acl_transition` on the output** echoes the applied transition on a
 * crossing (absent on same-bucket): the policy, both resolved space
 * bindings, and the FULL preimage of every dropped grant row across the
 * whole subtree (rows are hard-deleted — this echo is the caller's
 * offboarding receipt). The audit effect projects from this echo.
 *
 * **`new_parent_id` on the output is derived row truth**: the
 * destination collection's id, or `null` for either root destination —
 * exactly what the `collections.parent_id` column now holds.
 */

import { z } from "zod";

import { AclTransitionOutputSchema, AclTransitionPolicySchema } from "../shared/grant";
import {
  CollectionIdInputSchema,
  CollectionIdOutputSchema,
  SpaceIdInputSchema,
  SpaceIdOutputSchema,
} from "../shared/ids";

export const CollectionMoveDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("legacy_root") }).strict(),
  z.object({ kind: z.literal("space_root"), space_id: SpaceIdInputSchema }).strict(),
  z.object({ kind: z.literal("collection"), collection_id: CollectionIdInputSchema }).strict(),
]);

export const CollectionMoveInputSchema = z
  .object({
    collection_id: CollectionIdInputSchema,
    destination: CollectionMoveDestinationSchema,
    acl_policy: AclTransitionPolicySchema.optional(),
  })
  .strict();

export const CollectionMoveOutputSchema = z.object({
  collection_id: CollectionIdOutputSchema,
  // Derived row truth: `destination.collection_id` for a `collection`
  // destination, `null` for either root. Kept on the output because it
  // IS the persisted `parent_id` — the caller should not have to
  // re-derive the row from the union they sent.
  new_parent_id: CollectionIdOutputSchema.nullable(),
  new_order_key: z.string(),
  // Post-move space binding (`null` = legacy no-space bucket). On a
  // crossing this is the whole subtree's new binding, root included.
  new_space_id: SpaceIdOutputSchema.nullable(),
  updated_at: z.number(),
  acl_transition: AclTransitionOutputSchema.optional(),
});

export type CollectionMoveWireInput = z.input<typeof CollectionMoveInputSchema>;
export type CollectionMoveInput = z.output<typeof CollectionMoveInputSchema>;
export type CollectionMoveOutput = z.output<typeof CollectionMoveOutputSchema>;
