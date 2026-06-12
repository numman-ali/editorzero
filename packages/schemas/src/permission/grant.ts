/**
 * `permission.grant` wire + internal contract (ADR 0034, ADR 0040
 * Step 8) — the single source the capability, the API route, and any
 * other surface derive from.
 *
 * **Input** is the flat unique-edge spec (H12 — flat
 * `subject_kind`/`subject_id`, no nested PrincipalRef) plus the role:
 * `{resource_kind, resource_id, subject_kind, subject_id, role}`. The
 * handler upserts on the unique edge `(workspace_id, resource_kind,
 * resource_id, subject_kind, subject_id)` — `workspace_id` comes from
 * the principal's tenant scope, never the body.
 *
 *  - `resource_id` validates the UUIDv7 shape but stays a plain string
 *    after parse: the column is polymorphic (doc or space), so there is
 *    no single brand to narrow to. The handler brands per
 *    `resource_kind` for its typed row SELECT.
 *  - `subject_id` is a non-empty string only: user ids are
 *    Better-Auth-owned (may be UUIDv4 — same posture as
 *    `UserIdInputSchema`), agent ids are UUIDv7 but the agents table
 *    is an unshipped slice, so the agent-existence pre-check is a
 *    recorded Step-8 obligation rather than a schema rail. User
 *    subjects ARE validated in the handler (live workspace membership
 *    + space standing per the resource's placement).
 *
 * **Output** echoes the upserted grant row — the shared
 * `GrantRowOutputSchema` (see `../shared/grant`). On this capability
 * `is_guest` is always `0` (guest edges belong to `doc.add_guest`);
 * the wire shape stays `0 | 1` because it is the one shared row shape
 * across grant/revoke/list (ADR 0034: one definition, no drift copy).
 */

import { z } from "zod";

import {
  GrantResourceKindSchema,
  GrantRoleSchema,
  GrantRowOutputSchema,
  GrantSubjectKindSchema,
} from "../shared/grant";

export const PermissionGrantInputSchema = z
  .object({
    resource_kind: GrantResourceKindSchema,
    resource_id: z.uuid({ version: "v7", message: "must be a UUIDv7" }),
    subject_kind: GrantSubjectKindSchema,
    subject_id: z.string().min(1, "must not be empty"),
    role: GrantRoleSchema,
  })
  .strict();

export const PermissionGrantOutputSchema = GrantRowOutputSchema;

export type PermissionGrantWireInput = z.input<typeof PermissionGrantInputSchema>;
export type PermissionGrantInput = z.output<typeof PermissionGrantInputSchema>;
export type PermissionGrantOutput = z.output<typeof PermissionGrantOutputSchema>;
