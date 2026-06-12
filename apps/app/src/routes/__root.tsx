import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { PwaPrompt } from "../components/pwa-prompt";

/**
 * Root route — the shell every page renders inside. It carries the router
 * *context* type: the `queryClient` singleton is threaded in at `createRouter`
 * (main.tsx) so route `beforeLoad` guards (e.g. `_authed`) can prefetch and read
 * cached queries (the session) without importing the singleton directly. That is
 * the only reason this is `createRootRouteWithContext` rather than
 * `createRootRoute` — and once the context type is concrete, `createRouter` is
 * type-*required* to supply it, so this file and main.tsx change together.
 *
 * Otherwise intentionally minimal: the authed chrome lives in `_authed.tsx`;
 * the root is just the routing `<Outlet />`, the parent of `/login` (signed-out)
 * and the `_authed` layout (everything protected) — plus the PWA chrome
 * (ADR 0039: SW registration, update toast, install affordances), mounted
 * HERE so `/login` is covered too (in `vite dev` its registration hook is
 * the plugin's no-op stub; it only registers from a production build).
 */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <>
      <Outlet />
      <PwaPrompt />
    </>
  );
}
