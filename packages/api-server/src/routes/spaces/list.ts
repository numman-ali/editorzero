/**
 * `GET /spaces/list` — list the spaces visible to the caller.
 *
 * **Code-first route shape (ADR 0029); empty-input variant** (the
 * `doc.list` pattern — no `validator(...)` arm; the capability input
 * is the empty object, minted by the handler). The per-row visibility
 * rule (reach ∨ administer) lives inside the capability; the route
 * only dispatches. Deliberately unpaginated — see the capability /
 * schema headers for the scale rationale.
 *
 * **Response schema — reused, not re-declared (ADR 0034).**
 * `SpaceListOutputSchema` wraps `SpaceRowOutputSchema` — the one space
 * row shape.
 */

import { CapabilityId } from "@editorzero/ids";
import { SpaceListOutputSchema } from "@editorzero/schemas/space/list";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent } from "../../lib/openapi";

const SPACE_LIST_ID = CapabilityId("space.list");

export const list = new Hono<ApiEnv>().get(
  "/list",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "List the spaces visible to the caller.",
      responses: {
        200: {
          description:
            "Visible spaces, name-ascending. Open spaces, the caller's memberships and " +
            "space grants, their own personal space; workspace owners/admins additionally " +
            "see every team space.",
          content: jsonContent(SpaceListOutputSchema),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `workspace:read`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
      },
    }),
    async (c) => {
      const principal = c.var.principal;
      const input = {};
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_LIST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceListOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
