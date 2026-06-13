/**
 * Bearer arm of the HTTP principal resolver (ADR 0044 Decision 4) —
 * "Better Auth authenticates humans; editorzero authenticates agents."
 *
 * Composes the owned agent-token path IN FRONT OF the cookie resolver:
 *
 *   - **No `Authorization: Bearer …` header** → the cookie path,
 *     unchanged. A non-Bearer `Authorization` (e.g. `Basic`) is also
 *     deferred to the cookie path — it is not an agent attempt.
 *   - **A Bearer header IS present** → the agent path. An invalid agent
 *     token resolves to `null` (→ the middleware's 401) and NEVER falls
 *     back to the ambient cookie. An explicit credential that fails is a
 *     401, not a silent downgrade to whatever session cookie rode along
 *     — the confused-deputy guard the ADR calls out by name.
 *   - **Bearer wins when both are present.** The header is checked first;
 *     the cookie is only consulted when no Bearer was sent.
 *
 * **Discriminator.** Only WELL-FORMED `ez_agent_` tokens are ours —
 * `isWellFormedAgentToken` (the owned format, `token-crypto.ts`: prefix +
 * exactly 43 base62 chars). A Bearer that fails the shape check (wrong
 * prefix, wrong length, non-base62 body) cannot be an agent token, so we
 * 401 it WITHOUT hashing it or hitting the unique index — still an
 * explicit-bearer failure, so still no cookie fallback.
 *
 * **Layering.** This module is the composition seam where the three
 * pieces meet: `isWellFormedAgentToken` + `hashAgentToken` +
 * `parseStoredScopes` (from `@editorzero/capabilities`, above db), the
 * raw row from `resolveAgentToken` (`@editorzero/db`, below capabilities),
 * and the `AgentPrincipal` shape (`@editorzero/principal`). The db
 * resolver stays capabilities-free; the assembly + scope-parse happen
 * here, in the layer that already depends on all three.
 *
 * **`parseStoredScopes` may throw — by design.** A token row whose
 * `scopes` column is not a valid `Scope[]` is structural corruption
 * (the only writer is the validated mint path); the parser throws
 * rather than silently filter, and the principal middleware projects a
 * throw to a 500 ("corrupted token" — see its docstring). We do NOT
 * catch it: a 401 would hide server-state corruption behind a benign
 * "not authenticated".
 *
 * **The composed resolve is header-shaped; HTTP and collab share it
 * (ADR 0044 Decision 5 step 2 / Codex SF2).** The bearer-then-cookie
 * decision operates purely on a `Headers` bag, so the reusable core is
 * `createComposedPrincipalResolver` (`(headers) => Principal | null`).
 * `createBearerThenCookieResolver` is the thin Hono-context adapter the
 * HTTP principal middleware mounts; the collab WS upgrade + per-frame
 * policy consume the SAME core directly. One bearer-then-cookie
 * implementation, no second copy to drift — the accidental cookie-only
 * collab path SF2 warns about cannot exist.
 */

import {
  hashAgentToken,
  isWellFormedAgentToken,
  parseStoredScopes,
} from "@editorzero/capabilities";
import type { ResolveAgentToken } from "@editorzero/db";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";

import type { PrincipalResolver } from "./principal";

/** RFC 6750 `Bearer` scheme, matched case-insensitively per the spec. */
const BEARER_SCHEME = /^Bearer[ \t]+/i;

/**
 * Whether an `Authorization` header value carries the `Bearer` scheme —
 * the lane discriminant. EXPORTED so the collab WS Origin gate
 * (`attachCollab`, apps/server) decides "cookie lane vs bearer lane"
 * with the EXACT predicate the resolver uses to decide "cookie vs
 * bearer"; a divergence would let a request be treated as cookie-lane
 * for the CSRF/Origin gate but bearer-lane for resolution (or vice
 * versa), opening a gap. One regex, one source of truth.
 */
export function hasBearerScheme(authorization: string | undefined): boolean {
  return authorization !== undefined && BEARER_SCHEME.test(authorization);
}

/**
 * The credential after a `Bearer ` scheme prefix, or `null` when no
 * Bearer header is present (a missing `Authorization`, or a non-Bearer
 * scheme). `null` is the signal to defer to the cookie path; a non-null
 * return — even an empty or malformed token — means an explicit bearer
 * was presented and the cookie path must NOT be reached.
 */
function extractBearer(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (header === null) return null;
  const match = BEARER_SCHEME.exec(header);
  if (match === null) return null;
  return header.slice(match[0].length);
}

export interface BearerThenCookieResolverOptions {
  /** Owned agent-token lookup — `createResolveAgentToken(driver)`. */
  readonly resolveAgentToken: ResolveAgentToken;
  /**
   * The cookie (Better Auth) resolver, consulted only when no Bearer
   * header was sent — typically `createBetterAuthResolver({ auth,
   * loadRoles })`.
   */
  readonly cookieResolve: (headers: Headers) => Promise<UserPrincipal | null>;
}

/**
 * The composed bearer-then-cookie principal resolve, header-shaped. The
 * reusable core: the HTTP principal middleware mounts it via the
 * `createBearerThenCookieResolver` Hono adapter; the collab WS surface
 * (upgrade gate + per-frame policy) consumes it directly. Returns
 * `Principal | null` — `null` is "no/invalid credential" (the HTTP
 * middleware 401s; collab refuses the upgrade / denies the frame).
 */
export type ComposedPrincipalResolver = (headers: Headers) => Promise<Principal | null>;

/**
 * Build the header-shaped bearer-then-cookie resolver (the SSOT core —
 * see the file header). The Hono adapter and the collab consumers all
 * route through THIS, so the confused-deputy guard (explicit bearer
 * never falls back to the cookie) and the full-shape gate hold
 * identically on every surface.
 */
export function createComposedPrincipalResolver(
  options: BearerThenCookieResolverOptions,
): ComposedPrincipalResolver {
  const { resolveAgentToken, cookieResolve } = options;
  return async (headers) => {
    const bearer = extractBearer(headers);
    if (bearer === null) {
      return cookieResolve(headers);
    }
    // An explicit Bearer was presented — from here, never the cookie. Gate
    // on the FULL token shape (prefix + exactly 43 base62 chars), not just
    // the prefix: a malformed prefixed string 401s without hashing
    // arbitrary-length input or probing the unique index (ADR 0044).
    if (!isWellFormedAgentToken(bearer)) {
      return null;
    }
    const resolution = await resolveAgentToken(hashAgentToken(bearer));
    if (resolution === null) {
      return null;
    }
    const principal: AgentPrincipal = {
      kind: "agent",
      id: resolution.agent_id,
      workspace_id: resolution.workspace_id,
      owner_user_id: resolution.owner_user_id,
      scopes: parseStoredScopes(resolution.scopes),
      token_id: resolution.token_id,
      token_kind: "api-key",
      // `acting_as` is intentionally absent: an api-key token acts as the
      // agent itself. Delegated (`agent-auth`) tokens carry `act.sub` and
      // arrive on a different arm (a later increment).
    };
    return principal;
  };
}

/**
 * Hono-context adapter over {@link createComposedPrincipalResolver} for
 * the HTTP principal middleware. Pure plumbing — `c.req.raw.headers` into
 * the header-shaped core; all the bearer/cookie logic lives in the core.
 */
export function createBearerThenCookieResolver(
  options: BearerThenCookieResolverOptions,
): PrincipalResolver {
  const composed = createComposedPrincipalResolver(options);
  return (c) => composed(c.req.raw.headers);
}
