/**
 * `GET /agents/token_list/:agent_id` — list one agent's tokens.
 *
 * Code-first route (ADR 0029); P2 param variant (the `space.get`
 * pattern). Visibility rides the AGENT'S visibility — if the caller
 * can see the agent, they see its token rows, which carry display
 * identity (prefix + last4), scopes, tier, expiry, and lifecycle, and
 * structurally CANNOT carry anything verifiable (no `token_hash` on
 * the output shape). Revoked agents' tokens list too (forensics).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  AgentTokenListInputSchema,
  AgentTokenListOutputSchema,
} from "@editorzero/schemas/agent/token_list";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AGENT_TOKEN_LIST_ID = CapabilityId("agent.token_list");

export const tokenList = new Hono<ApiEnv>().get(
  "/token_list/:agent_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["agents"],
      summary: "List an agent's tokens (display identity + lifecycle; never the secret).",
      responses: {
        200: {
          description:
            "The agent's tokens, oldest first — prefix + last4, scopes, tier, expiry, " +
            "lifecycle. Revoked/expired rows included (client-partitioned).",
          content: jsonContent(AgentTokenListOutputSchema),
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
          description: "Agent not found — or outside the caller's visibility.",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", AgentTokenListInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AGENT_TOKEN_LIST_ID,
          input: c.req.valid("param"),
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AgentTokenListOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
