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
 * **Code-first INFRA shape (ADR 0029).** Like every route this is a
 * self-contained `Hono<ApiEnv>` sub-app built via
 * `factory.createHandlers(describeRoute({ ... }), handler)`. But infra
 * routes are *not* capability dispatches: there is no `c.var.dispatcher`
 * call, no `EditorZeroError` to catch, and so no `errorResponse` mapping.
 * The handler is **synchronous** — it reads `c.var.principal` (no `as`
 * cast; it is already the `UserPrincipal | AgentPrincipal` union) and
 * returns the projection through `c.json(..., 200)`. The route mounts at
 * a path relative to its domain (`/whoami`); the `infra` domain mounts at
 * `/infra` on the trunk, so the external path is `/infra/whoami` and
 * `hc<AppType>` reconstructs `client.infra.whoami.$get`.
 *
 * This route is auth-gated via `createPrincipalMiddleware` attached by
 * `createApiApp` to `/infra/whoami` exactly — `/infra/health` stays
 * public (the prefix match on `/infra/*` is not used because the two
 * routes have different auth postures). Unauthenticated callers get
 * 401 before this handler runs; that 401 is the middleware's return, so
 * it is a `describeRoute` *declaration* only (it does not feed `hc`,
 * exactly like a capability route's cross-cutting 400/401).
 *
 * **Why the response schema is a discriminated union.** `Principal` is
 * `UserPrincipal | AgentPrincipal`; both share the kind/id/workspace_id
 * spine but diverge on role/scope/token vocabulary. The two arms are
 * declared route-local (this projection is specific to the orientation
 * wire shape — there is no shared capability schema to reuse). Projecting
 * both branches here keeps the wire contract honest — CLI agent-mode
 * (future slice) will ship agent tokens and see the agent branch; the
 * human CLI bootstrap today sees only the user branch, but a wire
 * schema that omitted agents would need revising rather than extending.
 */

import { Hono } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../../env";
import { describeRoute, errEnvelope, factory, jsonContent } from "../../lib/openapi";

const UserPrincipalResponse = z.object({
  kind: z.literal("user"),
  id: z.string(),
  workspace_id: z.string(),
  roles: z.array(z.string()),
  session_id: z.string().nullable(),
  token_id: z.string().nullable(),
});

const AgentPrincipalResponse = z.object({
  kind: z.literal("agent"),
  id: z.string(),
  workspace_id: z.string(),
  owner_user_id: z.string().nullable(),
  scopes: z.array(z.string()),
  token_id: z.string(),
  token_kind: z.enum(["agent-auth", "api-key"]),
  acting_as: z.string().optional(),
});

const WhoamiResponse = z.discriminatedUnion("kind", [
  UserPrincipalResponse,
  AgentPrincipalResponse,
]);

export const whoami = new Hono<ApiEnv>().get(
  "/whoami",
  ...factory.createHandlers(
    describeRoute({
      tags: ["infra"],
      summary: "Resolve the calling principal (ADR 0025).",
      responses: {
        200: {
          description: "Principal resolved.",
          content: jsonContent(WhoamiResponse),
        },
        401: {
          description: "No valid credential.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
      },
    }),
    (c) => {
      const principal = c.var.principal;
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
  ),
);
