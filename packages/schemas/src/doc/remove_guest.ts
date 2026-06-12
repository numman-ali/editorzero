/**
 * `doc.remove_guest` wire + internal contract (ADR 0034, ADR 0040
 * Step 8).
 *
 * EDGE-addressed — `(doc_id, subject_kind, subject_id)`, not
 * grant_id-addressed: the unique-edge constraint makes the triple THE
 * id, and the lifecycle verb reads "remove this guest from this doc"
 * with no grant-id lookup round-trip. `permission.revoke(grant_id)`
 * stays the forensic by-row verb (and refuses guest edges — the two
 * lanes never cross; Codex guest-family review).
 *
 * Output is `GrantRowOutputSchema` verbatim — the deleted edge's full
 * preimage (the `permission.revoke` echo posture; the echo + the
 * `acl.revoke` audit row are the only durable records of the edge).
 */

import { z } from "zod";

import { GrantRowOutputSchema, GrantSubjectKindSchema } from "../shared/grant";
import { DocIdInputSchema } from "../shared/ids";

const DocRemoveGuestBaseSchema = z
  .object({
    doc_id: DocIdInputSchema,
    subject_kind: GrantSubjectKindSchema,
    subject_id: z.string().trim().min(1, "subject_id must not be empty"),
  })
  .strict();

export const DocRemoveGuestInputSchema = DocRemoveGuestBaseSchema;

// Route-side request pieces (P3 — path param + JSON body merged into
// one capability input). Derived from the SAME base object — no
// restated field.
export const DocRemoveGuestParamSchema = DocRemoveGuestBaseSchema.pick({ doc_id: true });
export const DocRemoveGuestBodySchema = DocRemoveGuestBaseSchema.omit({ doc_id: true });

export const DocRemoveGuestOutputSchema = GrantRowOutputSchema;

export type DocRemoveGuestWireInput = z.input<typeof DocRemoveGuestInputSchema>;
export type DocRemoveGuestInput = z.output<typeof DocRemoveGuestInputSchema>;
export type DocRemoveGuestOutput = z.output<typeof DocRemoveGuestOutputSchema>;
