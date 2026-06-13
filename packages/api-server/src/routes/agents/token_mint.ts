/**
 * `POST /agents/token_mint/:agent_id` — mint a bearer token (show-once).
 *
 * Code-first route (ADR 0029 / 0034); P3 split (the
 * `space.member_add` pattern) — param carries `agent_id`, body
 * carries `{tier, scopes?, expires_at?}`. The tier↔scopes contract
 * (named tier → scopes absent; custom → scopes required) and the
 * non-amplification ceiling (`scope_amplification` — an agent caller
 * cannot mint beyond its own held scopes) live in the capability
 * schema + handler; the dispatcher re-validates the merged input, so
 * the route-level Body validator is a wire-shape gate only.
 *
 * **The 200 body is the ONLY place the token secret ever appears**
 * (ADR 0044 show-once): `token` rides next to the stored row's
 * display identity (prefix + last4). It is never logged, never
 * audited, never readable again.
 *
 * **Status codes.**
 *   200 — minted; the token row + the one-time `token` secret.
 *   400 — schema failure (tier↔scopes ambiguity, literal `admin`,
 *         duplicate scopes, past `expires_at`), revoked agent
 *         (`agent_revoked`), amplification (`scope_amplification`),
 *         or an unattributable agent caller.
 *   401 — unauthenticated.
 *   403 — permission denied (`agent:create`).
 *   404 — agent missing (mutations are scope-bound; no visibility fold).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  AgentTokenMintBodySchema,
  AgentTokenMintOutputSchema,
  AgentTokenMintParamSchema,
} from "@editorzero/schemas/agent/token_mint";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AGENT_TOKEN_MINT_ID = CapabilityId("agent.token_mint");

export const tokenMint = new Hono<ApiEnv>().post(
  "/token_mint/:agent_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["agents"],
      summary: "Mint a bearer token for an agent; the secret appears once, in this response.",
      responses: {
        200: {
          description:
            "Minted — the stored token row plus the one-time `token` secret " +
            "(never retrievable again; store it now).",
          content: jsonContent(AgentTokenMintOutputSchema),
        },
        400: {
          description:
            "Validation error — tier↔scopes ambiguity, literal `admin` scope, past " +
            "expiry, revoked agent (`agent_revoked`), or an agent caller minting beyond " +
            "its own scopes (`scope_amplification`).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — `agent.token_mint` requires `agent:create`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Agent not found (mutations are scope-bound; no visibility fold).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", AgentTokenMintParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", AgentTokenMintBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AGENT_TOKEN_MINT_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AgentTokenMintOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
