/**
 * Module-level TanStack Query client singleton (v5 SPA pattern — created once
 * at module load, never inside a component, so React StrictMode's double-render
 * cannot recreate it; it lives outside the React tree).
 *
 * `retry: false` so an auth/permission failure (401 / `permission_denied`)
 * surfaces as `isError` immediately instead of being retried 3× — a retried
 * auth bounce feels broken. `staleTime: 30_000` trims duplicate refetches of
 * slow-changing data (the session principal, doc lists) within a 30s window.
 */
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
