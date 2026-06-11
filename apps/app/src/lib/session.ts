/**
 * Session / principal data-layer (ADR 0025 + ADR 0030/0033).
 *
 * `useSession()` is the React-facing hook; `fetchSession()` is the testable
 * plain function it wraps. The split exists so coverage is met by exercising
 * `fetchSession` (and `readErrorCode`) directly — no React renderer needed; the
 * hook body is one `useQuery` call, e2e-covered (Playwright + axe, ADR 0033).
 *
 * `GET /infra/whoami` is the principal-orientation route (ADR 0025) — NOT
 * Better Auth's `/auth/get-session`, which carries email/name but disagrees
 * with the dispatcher on workspace_id + roles (whoami.ts). Its `hc` type is
 * 200-only (a user|agent discriminated union); the unauthenticated 401 is
 * middleware-emitted with body `{ error: "unauthenticated" }` and is absent
 * from the typed union, so the `!res.ok` arm is read defensively at runtime.
 * `fetchSession` throws `ApiError` on that arm so react-query reports `isError`.
 */
import { type ApiClient, ApiError } from "@editorzero/api-client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { readErrorCode } from "./wire-error";

// `WhoamiSession` is DERIVED from the materialized client type (SSOT): the
// route's response zod schemas (whoami.ts) are not exported, so the `hc` client
// type is the only source. Two-step — resolve the `$get` response, then its
// `json()` body — and derived from `ApiClient` alone (no `hono/client` import,
// which apps/app does not directly depend on).
//
// NB: the principal's id fields are branded `@editorzero/ids` types
// (`UserId`/`WorkspaceId`/…) in the materialized client type. apps/app must keep
// `@editorzero/ids` as a dependency even though nothing here imports it by name —
// TS needs it to resolve the client type's transitive `import("@editorzero/ids")`
// references; without it those fields silently degrade to `any` (review finding).
// session.test.ts carries a compile-time guard that fails if that regresses.
type WhoamiResponse = Awaited<ReturnType<ApiClient["infra"]["whoami"]["$get"]>>;
export type WhoamiSession = Awaited<ReturnType<WhoamiResponse["json"]>>;

export const SESSION_QUERY_KEY = ["session"] as const;

/**
 * Fetch + project the calling principal. Takes the client as a parameter
 * (defaulting to the singleton) so tests inject a fake-fetch client without
 * touching the singleton. The 200-only `hc` union narrows `res.json()` to
 * `WhoamiSession` cast-free on the `res.ok` arm; the `!res.ok` arm is the
 * runtime-only 401/5xx, read defensively and thrown as `ApiError`.
 */
export async function fetchSession(client: ApiClient = apiClient): Promise<WhoamiSession> {
  const res = await client.infra.whoami.$get();
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

// `useSession` is a thin react-query wrapper; its body runs only inside a React
// render, so it is exercised by the Playwright + axe e2e lane (ADR 0033), not by
// unit coverage. All testable logic lives in `fetchSession` above.
/* v8 ignore start -- @preserve */
export function useSession() {
  return useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: () => fetchSession() });
}
/* v8 ignore stop -- @preserve */
