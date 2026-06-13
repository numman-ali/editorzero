/**
 * `POST /agents/update/:agent_id` — rename an agent.
 *
 * Code-first route (ADR 0029 / 0034); P3 split (the
 * `space.member_add` pattern) — the path param carries the domain id
 * (`agent_id`, the derived-binding convention the parity matrix
 * enforces), the JSON body carries `{name}`, and the two halves merge
 * into the capability input (Param/Body schemas derived from the same
 * base object — no restated wire copy).
 *
 * **Status codes.**
 *   200 — renamed (or idempotent same-name echo); the full agent row.
 *   400 — malformed body, or the agent is revoked (`agent_revoked` —
 *         terminal revocation refuses mutation).
 *   401 — unauthenticated.
 *   403 — permission denied (`agent:create` — the manage-tier scope).
 *   404 — agent missing (mutations are scope-bound; no visibility fold).
 *   409 — name collision with a live agent (`agent_name_taken`).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  AgentUpdateBodySchema,
  AgentUpdateOutputSchema,
  AgentUpdateParamSchema,
} from "@editorzero/schemas/agent/update";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AGENT_UPDATE_ID = CapabilityId("agent.update");

export const update = new Hono<ApiEnv>().post(
  "/update/:agent_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["agents"],
      summary: "Rename an agent (revocation is terminal — revoked agents refuse mutation).",
      responses: {
        200: {
          description: "Renamed — echoes the full agent row.",
          content: jsonContent(AgentUpdateOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed name, or the agent is revoked (`agent_revoked`).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — `agent.update` requires `agent:create`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Agent not found (mutations are scope-bound; no visibility fold).",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description: "Name collision — a live agent already uses this name (`agent_name_taken`).",
          content: jsonContent(errEnvelope("conflict")),
        },
      },
    }),
    validator("param", AgentUpdateParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", AgentUpdateBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AGENT_UPDATE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AgentUpdateOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
