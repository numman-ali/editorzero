/**
 * `permission.list` wire + internal contract (ADR 0034, ADR 0040
 * Step 8) — the single source the capability, the API route, and any
 * other surface derive from.
 *
 * **Resource-oriented**: `{resource_kind, resource_id}` enumerates the
 * ACL edges ON one doc or space — the "who has access" panel. A
 * subject-oriented sweep ("everything Bob holds") is a different
 * future capability; conflating the two would give this one two
 * authority rules.
 *
 * **Pagination** mirrors `workspace.member_list`: peek-limit + a
 * composite `(before_created_at, before_grant_id)` cursor, both-or-
 * neither (a timestamp half without its tiebreak cannot resume
 * deterministically). `limit`/`before_created_at` use
 * `z.coerce.number()` because this schema validates HTTP query strings
 * as well as CLI/MCP numeric arguments. Unlike `member_list`'s
 * `before_user_id` (Better-Auth-owned, any shape), `before_grant_id`
 * validates the UUIDv7 shape: grant ids are minted v7 by construction,
 * and the handler brands the cursor half for its typed predicate — a
 * garbage token must be a clean 400, not a brand-constructor 500. The
 * `next_cursor` halves stay plain on output (opaque page token).
 *
 * **Output items** are the shared `GrantRowOutputSchema` (the same row
 * shape `permission.grant` echoes and `permission.revoke` preimages) —
 * guest edges (`is_guest = 1`) are listed too: the access panel shows
 * the escape hatches, that's what the marker is FOR.
 */

import { z } from "zod";

import { GrantResourceKindSchema, GrantRowOutputSchema } from "../shared/grant";

export const PermissionListInputSchema = z
  .object({
    resource_kind: GrantResourceKindSchema,
    resource_id: z.uuid({ version: "v7", message: "must be a UUIDv7" }),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before_created_at: z.coerce.number().int().optional(),
    before_grant_id: z.uuid({ version: "v7", message: "must be a UUIDv7" }).optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.before_created_at === undefined && v.before_grant_id === undefined) ||
      (v.before_created_at !== undefined && v.before_grant_id !== undefined),
    { message: "before_created_at and before_grant_id must be provided together" },
  );

export const PermissionListOutputSchema = z.object({
  grants: z.array(GrantRowOutputSchema),
  next_cursor: z
    .object({
      before_created_at: z.number(),
      before_grant_id: z.string(),
    })
    .nullable(),
});

export type PermissionListWireInput = z.input<typeof PermissionListInputSchema>;
export type PermissionListInput = z.output<typeof PermissionListInputSchema>;
export type PermissionListOutput = z.output<typeof PermissionListOutputSchema>;
