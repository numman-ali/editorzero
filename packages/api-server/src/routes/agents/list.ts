/**
 * `GET /agents/list` — list the agents visible to the caller.
 *
 * Code-first route (ADR 0029); empty-input variant (the `space.list`
 * pattern — no `validator(...)` arm; the capability input is the
 * empty object, minted by the handler). Visibility: workspace
 * owners/admins (and agents holding `workspace:admin`) see every
 * agent; everyone else sees agents anchored to their own user.
 * Revoked agents are included (lifecycle is client-partitioned via
 * `revoked_at`) — terminal revocation keeps the record listable.
 */

import { CapabilityId } from "@editorzero/ids";
import { AgentListOutputSchema } from "@editorzero/schemas/agent/list";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent } from "../../lib/openapi";

const AGENT_LIST_ID = CapabilityId("agent.list");

export const list = new Hono<ApiEnv>().get(
  "/list",
  ...factory.createHandlers(
    describeRoute({
      tags: ["agents"],
      summary: "List the agents visible to the caller (revoked included).",
      responses: {
        200: {
          description:
            "Visible agents, name-ascending. Admin-tier callers see every agent; " +
            "others see agents anchored to their own user.",
          content: jsonContent(AgentListOutputSchema),
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
          capability_id: AGENT_LIST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AgentListOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
