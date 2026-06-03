import { createRootRoute, Outlet } from "@tanstack/react-router";

/**
 * Root route — the shell every page renders inside. Intentionally minimal: the
 * Base UI + Meridian Zero layout chrome (ADR 0037 / 0036) and the auth-gated
 * sidebar land in later #13 increments. For now it is just the routing
 * `<Outlet />`, so the file-based tree has a root to hang `/` and `/login` off
 * (ADR 0035 §2 — the first slice's only client routes).
 */
export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return <Outlet />;
}
