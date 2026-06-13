/**
 * `POST /agents/token_revoke` — terminally revoke ONE token.
 *
 * Code-first route (ADR 0029 / 0034); body-only input — the input id
 * is `token_id`, not the domain id `agent_id`, so the derived binding
 * carries no path param (the binding convention only lifts
 * `<domain>_id`). Scoped kill: the agent and its sibling tokens stay
 * live. Re-revoke refuses (`token_revoked`) — terminal, same as the
 * agent-level verb.
 *
 * **Status codes.**
 *   200 — revoked; echoes `{token_id, revoked_at}` (minimal terminal
 *         echo — the row stays listable via `agent.token_list`).
 *   400 — malformed token_id, or already revoked (`token_revoked`).
 *   401 — unauthenticated.
 *   403 — permission denied (`agent:revoke`).
 *   404 — token missing (mutations are scope-bound; no visibility
 *         fold).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  AgentTokenRevokeInputSchema,
  AgentTokenRevokeOutputSchema,
} from "@editorzero/schemas/agent/token_revoke";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AGENT_TOKEN_REVOKE_ID = CapabilityId("agent.token_revoke");

export const tokenRevoke = new Hono<ApiEnv>().post(
  "/token_revoke",
  ...factory.createHandlers(
    describeRoute({
      tags: ["agents"],
      summary: "Terminally revoke one token; the agent and sibling tokens stay live.",
      responses: {
        200: {
          description: "Revoked — echoes the id + kill clock (the row stays listable).",
          content: jsonContent(AgentTokenRevokeOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed token_id, or already revoked (`token_revoked`; " +
            "revocation is terminal).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — `agent.token_revoke` requires `agent:revoke`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Token not found (mutations are scope-bound; no visibility fold).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("json", AgentTokenRevokeInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AGENT_TOKEN_REVOKE_ID,
          input: c.req.valid("json"),
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AgentTokenRevokeOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
