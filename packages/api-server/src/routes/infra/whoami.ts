/**
 * `GET /infra/whoami` — canonical principal-orientation route (ADR 0025).
 *
 * Wraps `c.var.principal` and projects it to the wire. **Not** Better
 * Auth's `/auth/get-session` — that returns BA's user/session state
 * (email, name, verified-at, session expiry, …) which is a different
 * shape from what the dispatcher/gate actually enforces. A CLI that
 * called `get-session` to "orient itself" would silently disagree with
 * every capability route on who the caller is — specifically on
 * `workspace_id` + `roles`, which BA doesn't know about
 * (`workspace_id` is minted by editorzero's `user.create.before` hook
 * and `roles` are sourced from `workspace_members` by the ADR 0024
 * resolver).
 *
 * This route is auth-gated via `createPrincipalMiddleware` attached by
 * `createApiApp` to `/infra/whoami` exactly — `/infra/health` stays
 * public (the prefix match on `/infra/*` is not used because the two
 * routes have different auth postures). Unauthenticated callers get
 * 401 before this handler runs.
 *
 * **Why the response schema is a discriminated union.** `Principal` is
 * `UserPrincipal | AgentPrincipal`; both share the kind/id/workspace_id
 * spine but diverge on role/scope/token vocabulary. Projecting both
 * branches here keeps the wire contract honest — CLI agent-mode
 * (future slice) will ship agent tokens and see the agent branch; the
 * human CLI bootstrap today sees only the user branch, but a wire
 * schema that omitted agents would need revising rather than extending.
 */

import type { Principal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const UserPrincipalResponse = z
  .object({
    kind: z.literal("user"),
    id: z.string(),
    workspace_id: z.string(),
    roles: z.array(z.string()),
    session_id: z.string().nullable(),
    token_id: z.string().nullable(),
  })
  .openapi("UserPrincipalResponse");

const AgentPrincipalResponse = z
  .object({
    kind: z.literal("agent"),
    id: z.string(),
    workspace_id: z.string(),
    owner_user_id: z.string().nullable(),
    scopes: z.array(z.string()),
    token_id: z.string(),
    token_kind: z.enum(["agent-auth", "api-key"]),
    acting_as: z.string().optional(),
  })
  .openapi("AgentPrincipalResponse");

const WhoamiResponse = z
  .discriminatedUnion("kind", [UserPrincipalResponse, AgentPrincipalResponse])
  .openapi("WhoamiResponse");

const whoamiRoute = createRoute({
  method: "get",
  path: "/infra/whoami",
  tags: ["infra"],
  summary: "Resolve the calling principal (ADR 0025).",
  responses: {
    200: {
      description: "Principal resolved.",
      content: { "application/json": { schema: WhoamiResponse } },
    },
    401: {
      description: "No valid credential.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("unauthenticated") }),
        },
      },
    },
  },
});

export const whoami = defineOpenAPIRoute<typeof whoamiRoute, ApiEnv, true>({
  route: whoamiRoute,
  handler: (c) => {
    const principal: Principal = c.var.principal;
    if (principal.kind === "user") {
      return c.json(
        {
          kind: "user" as const,
          id: principal.id,
          workspace_id: principal.workspace_id,
          roles: [...principal.roles],
          session_id: principal.session_id,
          token_id: principal.token_id,
        },
        200,
      );
    }
    return c.json(
      {
        kind: "agent" as const,
        id: principal.id,
        workspace_id: principal.workspace_id,
        owner_user_id: principal.owner_user_id,
        scopes: [...principal.scopes],
        token_id: principal.token_id,
        token_kind: principal.token_kind,
        ...(principal.acting_as !== undefined ? { acting_as: principal.acting_as } : {}),
      },
      200,
    );
  },
  addRoute: true,
});
