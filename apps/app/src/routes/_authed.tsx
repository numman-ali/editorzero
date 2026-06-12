import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppShell } from "../components/app-shell";
import { isLoginRequired } from "../lib/auth-guard";
import { fetchSession, SESSION_QUERY_KEY, useSession } from "../lib/session";
import { useWorkspace, workspaceGetQueryOptions } from "../lib/workspace";

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
 * The workspace identity (`workspace.get` — the sidebar block on every authed
 * screen) is warmed here too, AFTER the session ensure: an expired cookie hits
 * the session 401 → login redirect first, so the workspace fetch only ever runs
 * authenticated; its own failure (5xx, network) is a real fault and re-throws
 * to the error boundary.
 *
 * `ensureQueryData` resolves from cache within `staleTime` (30s, query-client),
 * so sibling navigations don't refetch either query; the query client used is
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
    await context.queryClient.ensureQueryData(workspaceGetQueryOptions());
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { data: session } = useSession();
  const { data: workspace } = useWorkspace();
  // `beforeLoad` guarantees both are cached before this renders; this
  // narrows away the brief `undefined` the hooks' return types admit.
  if (session === undefined || workspace === undefined) {
    return null;
  }
  return (
    <AppShell session={session} workspace={workspace}>
      <Outlet />
    </AppShell>
  );
}
