/**
 * `POST /workspaces/member_update_role` — workspace.member_update_role
 * surface (invariant 4). Code-first shape (ADR 0029); mirrors the golden
 * `docs/create` route — a self-contained `Hono<ApiEnv>` sub-app built from
 * `factory.createHandlers(describeRoute, validator, handler)`:
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (per-status response
 *      schemas). Documents the contract; does not feed `hc`.
 *   2. `validator("json", WorkspaceMemberUpdateRoleInputSchema, hook)` —
 *      Standard-Schema body validation; the hook projects a parse failure to
 *      the `{ error: "validation_failed" }` envelope at 400 (a cross-cutting
 *      middleware return, intentionally not an `hc` arm — see `lib/errors.ts`).
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`, dispatches,
 *      and returns the dispatcher's output through `c.json`. The dispatcher
 *      *throws* `EditorZeroError` subclasses; `errorResponse(c, err)` maps them
 *      to explicit, literal-typed `c.json` returns — those returns are what
 *      `hc<AppType>` reads to infer the error arms (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays the `Principal` union;
 * capability routes serve agent principals too (invariant 8). `dispatch`
 * returns `Promise<unknown>`; rather than *assert* with `as`, the handler
 * *parses* through `WorkspaceMemberUpdateRoleOutputSchema.parse` — the honest
 * `unknown`→typed narrowing and a runtime guard against dispatcher drift.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `WorkspaceMemberUpdateRoleInputSchema` / `WorkspaceMemberUpdateRoleOutputSchema`
 * from `@editorzero/schemas/workspace/member_update_role` are the single source
 * the capability also consumes. The route does not re-declare the wire shape —
 * that is the point of this migration. Body carries `{ user_id, role }`;
 * `user_id` is not a path param (the `<domain>_id` convention belongs to
 * `workspace_id`, the target thing in the URL), and this capability targets the
 * ambient workspace (pinned via principal).
 *
 * **Status — 200 OK** (update, not create). Echoes `{ workspace_id, user_id,
 * role, updated_at }` so callers don't need a follow-up list.
 *
 * **409 Conflict — `last_owner_protected` | `conflict`.** Demoting the only
 * live owner would leave the workspace ownerless; `LastOwnerError` surfaces as
 * 409. A PG serializable race that loses at commit surfaces as `conflict` —
 * same invariant family, transient. The check + UPDATE run inside the
 * write-path tx (`METADATA_ONLY_CAPABILITIES` membership gives a tx-bound
 * `ctx.db`), so a concurrent demote-the-other-owner cannot slip through.
 *
 * Mounts at a path **relative** to its domain (`/member_update_role`); the
 * `workspaces` domain mounts at `/workspaces`, so the external path is
 * `/workspaces/member_update_role`. Audit + permission + write-path tx live
 * inside the dispatcher; the handler only dispatches.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  WorkspaceMemberUpdateRoleInputSchema,
  WorkspaceMemberUpdateRoleOutputSchema,
} from "@editorzero/schemas/workspace/member_update_role";
import { Hono } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const WORKSPACE_MEMBER_UPDATE_ROLE_ID = CapabilityId("workspace.member_update_role");

export const memberUpdateRole = new Hono<ApiEnv>().post(
  "/member_update_role",
  ...factory.createHandlers(
    describeRoute({
      tags: ["workspaces"],
      summary: "Change a workspace member's role; metadata-only, admin-only.",
      responses: {
        200: {
          description: "Role updated — post-patch metadata.",
          content: jsonContent(WorkspaceMemberUpdateRoleOutputSchema),
        },
        400: {
          description:
            "Validation error — missing user_id, unknown role, unknown body key, or target already has the asserted role (`role_unchanged`).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `workspace:admin`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "No live membership row for the target user_id in the caller's workspace.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "Demote blocked — `last_owner_protected` when the target is the only live owner; `conflict` when a PG serializable race loses at commit (same invariant family, transient).",
          content: jsonContent(z.object({ error: z.enum(["last_owner_protected", "conflict"]) })),
        },
      },
    }),
    validator("json", WorkspaceMemberUpdateRoleInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("json");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: WORKSPACE_MEMBER_UPDATE_ROLE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(WorkspaceMemberUpdateRoleOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
