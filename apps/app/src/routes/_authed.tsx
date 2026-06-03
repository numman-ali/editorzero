import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppShell } from "../components/app-shell";
import { isLoginRequired } from "../lib/auth-guard";
import { fetchSession, SESSION_QUERY_KEY, useSession } from "../lib/session";

/**
 * Pathless authed layout (ADR 0028 / 0030). Every protected route nests under
 * this. `beforeLoad` prefetches the principal via the session query: if the
 * server answers 401 (no/expired cookie), it redirects to `/login` carrying the
 * attempted href so the user lands back here after signing in. Any other failure
 * (403, 5xx, network) re-throws to the router error boundary — only "not signed
 * in" becomes a login redirect (`isLoginRequired`). Running the check in
 * `beforeLoad` rather than a render hook means protected chrome never flashes
 * before the redirect.
 *
 * `ensureQueryData` resolves from cache within `staleTime` (30s, query-client),
 * so sibling navigations don't refetch the principal; the query client used is
 * the singleton threaded through the router context (main.tsx), not imported
 * here — the guard stays the cache's only writer on first load.
 */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData({
        queryKey: SESSION_QUERY_KEY,
        queryFn: () => fetchSession(),
      });
    } catch (error) {
      if (isLoginRequired(error)) {
        throw redirect({ to: "/login", search: { redirect: location.href } });
      }
      throw error;
    }
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { data: session } = useSession();
  // `beforeLoad` guarantees the session is cached before this renders; this
  // narrows away the brief `undefined` the hook's return type admits.
  if (session === undefined) {
    return null;
  }
  return (
    <AppShell session={session}>
      <Outlet />
    </AppShell>
  );
}
