/**
 * `POST /workspaces/member_add` — workspace.member_add surface
 * (invariant 4). Code-first shape (ADR 0029); see `docs/create.ts` for
 * the golden reference. Built from `factory.createHandlers(describeRoute,
 * validator, handler)`: `describeRoute` carries OpenAPI metadata only,
 * `validator("json", ...)` does Standard-Schema body validation and
 * projects a parse failure to the `{ error: "validation_failed" }`
 * envelope at 400, and the handler dispatches + maps thrown
 * `EditorZeroError`s through `errorResponse(c, err)` into the explicit,
 * literal-typed `c.json` returns that `hc<AppType>` reads as the error
 * union (ADR 0029 §4).
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `WorkspaceMemberAddInputSchema` / `WorkspaceMemberAddOutputSchema` from
 * `@editorzero/schemas/workspace/member_add` are the single source the
 * capability also consumes; this route never re-states the wire shape.
 * The membership-op contract keeps `user_id` a plain non-empty string on
 * input (Better-Auth-owned IDs may be UUIDv4; the handler brands it), so
 * `c.req.valid("json")` is the wire shape verbatim. `dispatch` returns
 * `unknown`; the handler narrows it with `WorkspaceMemberAddOutputSchema.parse`
 * (the honest `unknown`→typed narrowing + a drift guard), never an `as`.
 *
 * Metadata-only mutation. Adds or revives-in-place a workspace membership
 * row; scope `workspace:admin`. Body carries `{user_id, role}` — not a
 * path param because the domain's `<domain>_id` convention belongs to
 * `workspace_id`, and this capability targets the ambient workspace
 * (pinned via principal).
 *
 * **Status — 200 OK** (add-or-revive, not create — the API-level
 * distinction between fresh-INSERT and soft-deleted-revive is hidden from
 * the surface; both are "member now exists with role X"). Echoes
 * `{workspace_id, user_id, role, created_at, updated_at}` so callers
 * distinguishing the two branches can read `created_at` (preserved on
 * revive) vs `updated_at` (always bumped).
 *
 * **409 Conflict — `member_already_exists`.** The target already has a
 * live membership row; the caller's view of the roster is stale. Role
 * changes on an existing member flow through
 * `workspace.member_update_role`. `conflict` surfaces for the PG
 * serializable race where two concurrent revives both pass their in-tx
 * pre-check and one aborts at commit.
 *
 * **No 404 branch in slice 1.** An input `user_id` referencing a
 * non-existent BA `user` row surfaces as an untyped error (pre-check
 * deferred to the user-resolution slice).
 *
 * **Audit + permission + dispatcher tx live inside the dispatcher.** The
 * handler only dispatches.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  WorkspaceMemberAddInputSchema,
  WorkspaceMemberAddOutputSchema,
} from "@editorzero/schemas/workspace/member_add";
import { Hono } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const WORKSPACE_MEMBER_ADD_ID = CapabilityId("workspace.member_add");

export const memberAdd = new Hono<ApiEnv>().post(
  "/member_add",
  ...factory.createHandlers(
    describeRoute({
      tags: ["workspaces"],
      summary: "Add or revive a workspace member; metadata-only, admin-only.",
      responses: {
        200: {
          description:
            "Member added or revived-in-place. `created_at` preserved across revive (ADR 0024 §5); `updated_at` always bumped.",
          content: jsonContent(WorkspaceMemberAddOutputSchema),
        },
        400: {
          description: "Validation error — missing user_id, unknown role, or unknown body key.",
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
        409: {
          description:
            "Add blocked — `member_already_exists` when the target has a live membership row; `conflict` when a PG serializable race loses at commit (same invariant family, transient).",
          content: jsonContent(z.object({ error: z.enum(["member_already_exists", "conflict"]) })),
        },
      },
    }),
    validator("json", WorkspaceMemberAddInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("json");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: WORKSPACE_MEMBER_ADD_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(WorkspaceMemberAddOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
