/**
 * `POST /agents/revoke/:agent_id` — terminally revoke an agent.
 *
 * Code-first route (ADR 0029 / 0034); param-only input (the
 * `space.archive` pattern). Revocation is TERMINAL (ADR 0044): no
 * un-revoke exists, every token dies with the identity (resolver-side
 * conjunction — token rows are not retro-patched), and a second
 * revoke refuses (`agent_revoked`) — the first kill clock is THE
 * record. The row stays visible/listable afterwards.
 *
 * **Status codes.**
 *   200 — revoked; echoes `{agent_id, revoked_at}` (minimal terminal
 *         echo — the row remains readable via `agent.get`).
 *   400 — malformed agent_id, or already revoked (`agent_revoked`).
 *   401 — unauthenticated.
 *   403 — permission denied (`agent:revoke`).
 *   404 — agent missing (mutations are scope-bound; no visibility fold).
 */

import { CapabilityId } from "@editorzero/ids";
import { AgentRevokeInputSchema, AgentRevokeOutputSchema } from "@editorzero/schemas/agent/revoke";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AGENT_REVOKE_ID = CapabilityId("agent.revoke");

export const revoke = new Hono<ApiEnv>().post(
  "/revoke/:agent_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["agents"],
      summary: "Terminally revoke an agent — every token dies with the identity; no un-revoke.",
      responses: {
        200: {
          description: "Revoked — echoes the id + kill clock (the row stays readable).",
          content: jsonContent(AgentRevokeOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed agent_id, or already revoked (`agent_revoked`; " +
            "revocation is terminal, the first kill clock is the record).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — `agent.revoke` requires `agent:revoke`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Agent not found (mutations are scope-bound; no visibility fold).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", AgentRevokeInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AGENT_REVOKE_ID,
          input: c.req.valid("param"),
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AgentRevokeOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
