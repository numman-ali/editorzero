/**
 * `permission.revoke` wire + internal contract (ADR 0034, ADR 0040
 * Step 8) — the single source the capability, the API route, and any
 * other surface derive from.
 *
 * **Input** is the grant id alone: a revoke targets one specific edge,
 * and the id is what `permission.grant` returned / `permission.list`
 * enumerates. No resource/subject echo in the request — the row is the
 * truth, and asking the caller to restate it would only create a
 * mismatch class to validate.
 *
 * **Output** echoes the deleted row's FULL preimage — the shared
 * `GrantRowOutputSchema`. The grants lifecycle is hard-DELETE (H1):
 * after this call returns there is no row to re-read, so the response
 * (like the `acl.revoke` audit effect, Codex Step-7 HIGH 1) carries
 * everything an auditor or caller needs without a join back to state
 * that no longer exists.
 */

import { z } from "zod";

import { GrantRowOutputSchema } from "../shared/grant";
import { GrantIdInputSchema } from "../shared/ids";

export const PermissionRevokeInputSchema = z
  .object({
    grant_id: GrantIdInputSchema,
  })
  .strict();

export const PermissionRevokeOutputSchema = GrantRowOutputSchema;

export type PermissionRevokeWireInput = z.input<typeof PermissionRevokeInputSchema>;
export type PermissionRevokeInput = z.output<typeof PermissionRevokeInputSchema>;
export type PermissionRevokeOutput = z.output<typeof PermissionRevokeOutputSchema>;
