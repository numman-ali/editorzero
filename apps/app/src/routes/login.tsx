import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AuthForm } from "../components/auth-form";
import { safeRedirectTarget } from "../lib/auth";
import { SESSION_QUERY_KEY } from "../lib/session";

/**
 * `/login` — sign-in + sign-up. Stays top-level (reachable signed-out,
 * *outside* the `_authed` layout). `validateSearch` captures an optional
 * post-sign-in `redirect` target — the href the `_authed` guard bounced
 * from — cast-free: the `in`-operator narrowing makes `search.redirect` a
 * *named* access (not an index-signature one), satisfying both
 * `noPropertyAccessFromIndexSignature` (TS) and `useLiteralKeys` (Biome),
 * the same standoff `session.ts`/`theme.ts` navigate. The param is still
 * attacker-writable in a crafted link, so `safeRedirectTarget` clamps it
 * to an internal path before navigation.
 *
 * On success: invalidate the cached session (the guard's 401 left an error
 * entry; a stale success from a previous principal must not survive a
 * user switch), then navigate by raw `href` — the target is a full
 * internal href (path + search + hash), which typed `to` can't express.
 */
export const Route = createFileRoute("/login")({
  validateSearch: (search: unknown): { redirect?: string } => {
    if (
      typeof search === "object" &&
      search !== null &&
      "redirect" in search &&
      typeof search.redirect === "string"
    ) {
      return { redirect: search.redirect };
    }
    return {};
  },
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { redirect } = Route.useSearch();
  return (
    <div className="login-field">
      <header className="login-topstrip">
        <div className="lhs">
          <div className="logo">
            <span className="mark" aria-hidden="true">
              <span className="cross" />
              <span className="cross-ring" />
            </span>
            <span className="word">
              editor<b>zero</b>
            </span>
          </div>
          <span className="div hideS" />
          <span className="coord hideS">
            SELF-HOSTED · <b>ENTRY</b>
          </span>
        </div>
      </header>
      <main className="login-stage">
        <AuthForm
          onAuthenticated={async () => {
            await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
            await navigate({ href: safeRedirectTarget(redirect) });
          }}
        />
      </main>
      <footer className="login-footer">
        <div className="ms">
          <span>
            editor<b>zero</b> · AGPL-3.0
          </span>
        </div>
        <div className="rhs">
          <span className="dot dot--agent" aria-hidden="true" />
          <span>HUMANS + AGENTS AS PEERS</span>
        </div>
      </footer>
    </div>
  );
}
