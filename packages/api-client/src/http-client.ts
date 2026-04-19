/**
 * `createHttpClient` — typed RPC over a real fetch (ADR 0021 Decision §2).
 *
 * Consumed by the CLI (`apps/cli` via `bun build --compile`), the web
 * frontend (`apps/app`, `apps/admin`), and any external consumer that
 * authenticates with a bearer token, API key, or cookie. Network hops
 * happen; the middleware chain is the server's, not the client's.
 *
 * The `auth` option is deliberately a *function* that returns the
 * headers to attach rather than a static string. Two reasons:
 *
 *  1. Bearer tokens rotate (session refresh, agent-token renewal).
 *     Functional resolution means the client picks up the current
 *     token per-call without callers plumbing refresh state.
 *  2. Frontend + CLI + agent harness each resolve auth differently
 *     (cookie jar / keychain / env var / device-flow artifact); the
 *     function lets each binding supply its own resolver without
 *     growing a per-caller shim.
 *
 * When no auth resolver is provided, no `Authorization` / `Cookie`
 * header is attached — useful for `/health` and `/docs` probes.
 */

import type { AppType } from "@editorzero/api-server";
import { hc } from "hono/client";

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly auth?: () => Promise<Record<string, string>> | Record<string, string>;
  readonly fetch?: typeof fetch;
}

export type ApiClient = ReturnType<typeof hc<AppType>>;

export function createHttpClient(options: HttpClientOptions): ApiClient {
  const { baseUrl, auth, fetch: fetchImpl } = options;
  const wrapped: typeof fetch = async (input, init) => {
    const extra = auth ? await auth() : {};
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(extra)) {
      headers.set(k, v);
    }
    const effectiveFetch = fetchImpl ?? fetch;
    return effectiveFetch(input, { ...init, headers });
  };
  return hc<AppType>(baseUrl, { fetch: wrapped });
}
