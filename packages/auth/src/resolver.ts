/**
 * `createBetterAuthResolver` — principal-resolution adapter
 * (ADR 0010 / ADR 0016).
 *
 * Hands a `PrincipalResolver`-shaped callback that the api-server's
 * `createPrincipalMiddleware({ resolve })` consumes. The contract is:
 *
 *   (headers) => Promise<UserPrincipal | null>
 *
 * Internally it calls `auth.api.getSession({ headers })`, reads the
 * session + user rows, and maps them into our `UserPrincipal` shape.
 * `null` means unauthenticated (no session cookie, or an expired /
 * revoked session) — the caller's middleware translates that to 401.
 *
 * **Scope today.** Resolves `UserPrincipal` only (cookie-session
 * path). Agent principals (`api-key`, `agent-auth` tokens) land in
 * follow-up slices that add resolvers here returning
 * `AgentPrincipal` — the api-server's `PrincipalResolver` signature
 * already accepts `UserPrincipal | AgentPrincipal | null`, so those
 * resolvers compose with this one without contract change.
 *
 * **`workspaceId` read from `user.workspaceId`.** The `additionalFields`
 * declaration in `create-auth.ts` stores `workspaceId` on the user
 * row; Better Auth's `getSession` returns the full user row in
 * `session.user`, so the additional field is accessible without an
 * extra DB call. Brand-cast to `WorkspaceId` at the boundary.
 *
 * **`session_id` wiring.** Cookie-based sessions have a
 * `session.id`; we brand-cast to `SessionId`. PAT-based sessions
 * (future, via `@better-auth/api-key` with `enableSessionForAPIKeys`)
 * will land here with `session.id === null` and `token_id` set
 * from the API-key reference — a later resolver enhancement.
 */

import { SessionId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";

import type { Auth } from "./create-auth";

/**
 * Resolver signature shared with `@editorzero/api-server`'s
 * `PrincipalResolver`. Duplicated here (not imported) to keep
 * `@editorzero/auth` independent of the api-server package; the
 * shapes are structurally compatible at the call site.
 */
export type BetterAuthResolver = (headers: Headers) => Promise<UserPrincipal | null>;

export function createBetterAuthResolver(auth: Auth): BetterAuthResolver {
  return async (headers) => {
    const result = await auth.api.getSession({ headers });
    if (result === null) return null;
    // Better Auth's `getSession` returns `{ session, user } | null`
    // (the shape is fully typed via `auth.$Infer.Session`; we keep
    // the access narrow here). `workspaceId` is present because the
    // `additionalFields` declaration made it required — but it's
    // typed as `string | undefined` on the inferred type because of
    // how `additionalFields` surfaces in the type. Guard defensively:
    // a user row missing `workspaceId` indicates the user was created
    // before the hook was wired (bootstrapping migration case) and
    // is structurally invalid for ADR 0016. Treat as unauthenticated
    // rather than silently assigning a placeholder workspace.
    const workspaceIdRaw = (result.user as { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceIdRaw !== "string" || workspaceIdRaw.length === 0) return null;

    return {
      kind: "user",
      id: UserId(result.user.id),
      workspace_id: WorkspaceId(workspaceIdRaw),
      // MVP: every authenticated user is a `member`. Role widening
      // to `owner` / `admin` lands with the `workspace_members`
      // table slice — until then, authz happens via scope checks
      // inside the dispatcher's `PermissionGate`, and role is a
      // default.
      roles: ["member"] as const,
      session_id: SessionId(result.session.id),
      token_id: null,
    };
  };
}
