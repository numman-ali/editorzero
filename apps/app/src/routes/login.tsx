import { createFileRoute } from "@tanstack/react-router";

/**
 * `/login` — sign-in. Stays top-level (reachable signed-out, *outside* the
 * `_authed` layout). `validateSearch` captures an optional post-sign-in
 * `redirect` target — the href the `_authed` guard bounced from — cast-free:
 * the `in`-operator narrowing makes `search.redirect` a *named* access (not an
 * index-signature one), satisfying both `noPropertyAccessFromIndexSignature`
 * (TS) and `useLiteralKeys` (Biome), the same standoff `session.ts`/`theme.ts`
 * navigate. The target is the router's internal href (path + search + hash, not
 * a full URL), so it is safe to round-trip; an open-redirect guard is only
 * needed if a future path ever sets it from an external URL.
 *
 * The actual Better Auth sign-in call (ADR 0030, via `@editorzero/api-client`)
 * lands in a later increment; this renders the frame.
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
  return (
    <main className="viewport">
      <h1>Sign in</h1>
    </main>
  );
}
