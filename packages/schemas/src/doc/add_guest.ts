/**
 * `doc.add_guest` wire + internal contract (ADR 0034, ADR 0040 Step 8 —
 * the explicit cross-ceiling escape hatch).
 *
 * Doc-scoped only: guest grants are the ONE deliberately-marked
 * ceiling-crossing edge, and they cross into a *doc*, never a space
 * (a space grant IS how space standing is conferred — `permission.grant`
 * owns it). `role` speaks `GuestGrantRoleSchema` (`GRANT_ROLES` minus
 * `owner` — see the shared schema's rationale). `subject_id` stays a
 * plain non-empty string: polymorphic over user/agent, branded by the
 * handler per `subject_kind`.
 *
 * Output is `GrantRowOutputSchema` verbatim — the ONE grant row shape
 * the whole `permission.*`/guest family echoes (`is_guest` is
 * structurally `1` here; same column, same shape, no per-verb variant).
 */

import { z } from "zod";

import {
  GrantRowOutputSchema,
  GrantSubjectKindSchema,
  GuestGrantRoleSchema,
} from "../shared/grant";
import { DocIdInputSchema } from "../shared/ids";

const DocAddGuestBaseSchema = z
  .object({
    doc_id: DocIdInputSchema,
    subject_kind: GrantSubjectKindSchema,
    subject_id: z.string().trim().min(1, "subject_id must not be empty"),
    role: GuestGrantRoleSchema,
  })
  .strict();

export const DocAddGuestInputSchema = DocAddGuestBaseSchema;

// Route-side request pieces (P3 — path param + JSON body merged into
// one capability input). Derived from the SAME base object — no
// restated field.
export const DocAddGuestParamSchema = DocAddGuestBaseSchema.pick({ doc_id: true });
export const DocAddGuestBodySchema = DocAddGuestBaseSchema.omit({ doc_id: true });

export const DocAddGuestOutputSchema = GrantRowOutputSchema;

export type DocAddGuestWireInput = z.input<typeof DocAddGuestInputSchema>;
export type DocAddGuestInput = z.output<typeof DocAddGuestInputSchema>;
export type DocAddGuestOutput = z.output<typeof DocAddGuestOutputSchema>;
