/**
 * `POST /agents/create` — register an agent principal (ADR 0044).
 *
 * Code-first route (ADR 0029 / 0034) mirroring `spaces/create.ts`:
 * one `validator("json", AgentCreateInputSchema)` reusing the
 * capability schema verbatim (SSOT), thin dispatcher call, output
 * re-parsed through the capability's output schema. Ownership is NOT
 * an input — the handler anchors `owner_user_id` to the caller's
 * human anchor (agent callers chain to their own owner).
 *
 * **Status codes.**
 *   200 — created; echoes the full agent row (revoked_at=null).
 *   400 — malformed body (empty/long name, unknown key) or an
 *         unattributable agent caller (`unattributable_agent`).
 *   401 — unauthenticated.
 *   403 — permission denied: `agent.create` requires `agent:create`
 *         (workspace owner/admin roles; agent tokens carrying it).
 *   409 — name collision with a live agent (`agent_name_taken`).
 */

import { CapabilityId } from "@editorzero/ids";
import { AgentCreateInputSchema, AgentCreateOutputSchema } from "@editorzero/schemas/agent/create";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AGENT_CREATE_ID = CapabilityId("agent.create");

export const create = new Hono<ApiEnv>().post(
  "/create",
  ...factory.createHandlers(
    describeRoute({
      tags: ["agents"],
      summary: "Register an agent principal; ownership anchors to the caller's human anchor.",
      responses: {
        200: {
          description: "Created — echoes the full agent row (revoked_at=null).",
          content: jsonContent(AgentCreateOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed name, unknown key, or an unattributable " +
            "agent caller (`unattributable_agent`).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — `agent.create` requires `agent:create`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        409: {
          description: "Name collision — a live agent already uses this name (`agent_name_taken`).",
          content: jsonContent(errEnvelope("conflict")),
        },
      },
    }),
    validator("json", AgentCreateInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AGENT_CREATE_ID,
          input: c.req.valid("json"),
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AgentCreateOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
