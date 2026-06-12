import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppShell } from "../components/app-shell";
import { isLoginRequired } from "../lib/auth-guard";
import { collectionListQueryOptions } from "../lib/collections";
import { fetchSession, SESSION_QUERY_KEY, useSession } from "../lib/session";
import { workspaceGetQueryOptions } from "../lib/workspace";

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
 * The sidebar's data — the workspace identity (`workspace.get`) and the
 * Collections tree (`collection.list`), both on every authed screen — is
 * warmed here too, in parallel, AFTER the session ensure: an expired cookie
 * hits the session 401 → login redirect first, so the chrome fetches only
 * ever run authenticated; their own failures (5xx, network) are real faults
 * and re-throw to the error boundary.
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
    await Promise.all([
      context.queryClient.ensureQueryData(workspaceGetQueryOptions()),
      context.queryClient.ensureQueryData(collectionListQueryOptions()),
    ]);
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { data: session } = useSession();
  const { data: workspace } = useQuery(workspaceGetQueryOptions());
  const { data: collections } = useQuery(collectionListQueryOptions());
  // `beforeLoad` guarantees all three are cached before this renders; this
  // narrows away the brief `undefined` the hooks' return types admit.
  if (session === undefined || workspace === undefined || collections === undefined) {
    return null;
  }
  return (
    <AppShell session={session} workspace={workspace} collections={collections.collections}>
      <Outlet />
    </AppShell>
  );
}
