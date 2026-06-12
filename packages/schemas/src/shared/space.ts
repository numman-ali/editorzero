/**
 * Shared space vocabulary + the ONE space row shape (ADR 0034 SSOT;
 * ADR 0040 Step 8).
 *
 * `SpaceRowOutputSchema` is the single output shape every `space.*`
 * capability echoes — create echo, update echo, archive/restore echo.
 * One definition; a verb-specific output restates NOTHING (the
 * `GrantRowOutputSchema` pattern). `deleted_at` is part of the row so
 * the archive echo can carry the handler clock and every other verb
 * echoes `null` — same column, same shape, no per-verb variant.
 *
 * `SpaceBaselineAccessSchema` speaks `BASELINE_ACCESS_ROLES` (the
 * GRANT_ROLES subset minus `owner`) — an implicit everyone-is-owner
 * baseline is never valid; the DDL CHECK and this schema agree via the
 * shared `@editorzero/scopes` array.
 */

import { BASELINE_ACCESS_ROLES, SPACE_KINDS, SPACE_TYPES } from "@editorzero/scopes";
import { z } from "zod";

import { SpaceIdOutputSchema, UserIdOutputSchema, WorkspaceIdOutputSchema } from "./ids";

export const SpaceKindSchema = z.enum(SPACE_KINDS);
export const SpaceTypeSchema = z.enum(SPACE_TYPES);
export const SpaceBaselineAccessSchema = z.enum(BASELINE_ACCESS_ROLES);

export const SpaceRowOutputSchema = z.object({
  space_id: SpaceIdOutputSchema,
  workspace_id: WorkspaceIdOutputSchema,
  kind: SpaceKindSchema,
  type: SpaceTypeSchema,
  // Bound by the spaces-table CHECK: non-null iff kind = 'personal'.
  owner_user_id: UserIdOutputSchema.nullable(),
  name: z.string(),
  slug: z.string(),
  baseline_access: SpaceBaselineAccessSchema,
  created_by: UserIdOutputSchema,
  created_at: z.number(),
  updated_at: z.number(),
  deleted_at: z.number().nullable(),
});

export type SpaceRowOutput = z.output<typeof SpaceRowOutputSchema>;
