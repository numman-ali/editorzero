/**
 * `GET /agents/get/:agent_id` — read a single agent's row.
 *
 * Code-first route (ADR 0029); P2 param variant (the `space.get`
 * pattern) — the capability input IS the single-id object
 * `{agent_id}`, reused directly as the param validator. Visibility
 * (owner-or-admin, folded to 404 — id probing reveals nothing) lives
 * inside the capability; revoked agents stay readable (terminal
 * revocation keeps the record visible).
 */

import { CapabilityId } from "@editorzero/ids";
import { AgentGetInputSchema, AgentGetOutputSchema } from "@editorzero/schemas/agent/get";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AGENT_GET_ID = CapabilityId("agent.get");

export const get = new Hono<ApiEnv>().get(
  "/get/:agent_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["agents"],
      summary: "Read a single agent's row (revoked agents stay readable).",
      responses: {
        200: {
          description: "The agent row.",
          content: jsonContent(AgentGetOutputSchema),
        },
        400: {
          description: "Validation error (malformed agent_id).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `workspace:read`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description:
            "Agent not found — or outside the caller's visibility (non-admins see " +
            "only agents anchored to their own user; the fold is deliberate).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", AgentGetInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AGENT_GET_ID,
          input: c.req.valid("param"),
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AgentGetOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
