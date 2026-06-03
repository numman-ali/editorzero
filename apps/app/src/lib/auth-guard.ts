/**
 * Client-side route auth-guard policy (ADR 0028 / 0030 / 0033).
 *
 * The server is the security boundary: every capability route and the
 * `/infra/whoami` principal route enforce the session cookie and answer `401`
 * when it is missing or expired (the trunk auth middleware + `whoami.ts`). This
 * guard is a *UX* layer on top of that — it turns the 401 into a redirect to
 * `/login` before any protected chrome renders, so an unauthenticated visit
 * never flashes the app shell. It can never be a security control (the server
 * already is one); a visitor who bypasses it still hits server 401s.
 *
 * Factored out of the route `beforeLoad` (which lives in `routes/**`, the
 * e2e-covered, unit-coverage-excluded tree) so the 401-vs-rethrow decision is
 * unit-testable in isolation.
 */
import { isApiError } from "@editorzero/api-client";

/**
 * Whether a thrown session-prefetch error means "not signed in" — the only case
 * the route guard converts into a redirect to `/login`. Every other failure
 * (a 403 `permission_denied`, a 5xx, a network/parse error) is a real error and
 * must surface to the router error boundary, not be masked as a login prompt.
 */
export function isLoginRequired(error: unknown): boolean {
  return isApiError(error) && error.status === 401;
}
