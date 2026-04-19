/**
 * `createServerClient` — typed RPC over `app.request` (ADR 0021 Decision §2).
 *
 * Three consumers share this client:
 *
 *  1. **Next Server Actions / RSC.** Forwards `cookie` / `authorization`
 *     from `next/headers` into the synthesized `Request` so Better
 *     Auth middleware on the Hono side resolves the same `Principal`
 *     the browser would see. Zero TCP hop — `app.request` dispatches
 *     through the full middleware chain in-process.
 *
 *  2. **vitest integration tests.** `testClient(app)` is the idiomatic
 *     Hono test primitive; this client is the production equivalent
 *     (same underlying `app.request.bind(app)` dispatch) with the
 *     auth-header forwarder attached. Tests that want auth behaviour
 *     exercised use this; tests that don't need auth can keep
 *     `testClient(app)` direct.
 *
 *  3. **Server-to-server capability composition** inside a Hono
 *     handler. One capability invoking another via this client rides
 *     the same middleware chain (auth → tenant → rate limit →
 *     dispatcher → audit) rather than reaching for the dispatcher
 *     directly. That preserves invariant 5 (no surface bypasses the
 *     permission check) by construction — the middleware is the only
 *     code path.
 *
 * **Header forwarding is an allowlist, not a `...req.headers` dump.**
 * Accepting arbitrary forwarded headers would let a caller spoof
 * `x-workspace-id` or tenant markers that downstream middleware keys
 * off. The allowlist is `cookie` + `authorization` by default;
 * callers can extend via `additionalHeaders` when a capability
 * genuinely needs another header (trace context, idempotency key).
 */

import type { AppType } from "@editorzero/api-server";
import type { Hono } from "hono";
import { hc } from "hono/client";

const DEFAULT_FORWARDED_HEADERS = ["cookie", "authorization"] as const;

export interface ServerClientOptions {
  // biome-ignore lint/suspicious/noExplicitAny: the Hono app generics differ per consumer; the call site only uses `app.request` whose contract is stable.
  readonly app: Pick<Hono<any, any, any>, "request">;
  readonly forwardHeaders?: () => Promise<Headers> | Headers;
  readonly additionalHeaders?: ReadonlyArray<string>;
}

type HonoRequestFn = Pick<Hono, "request">["request"];

export type ServerClient = ReturnType<typeof hc<AppType>>;

export function createServerClient(options: ServerClientOptions): ServerClient {
  const { app, forwardHeaders, additionalHeaders } = options;
  const allowlist = [...DEFAULT_FORWARDED_HEADERS, ...(additionalHeaders ?? [])];
  const wrapped: typeof fetch = async (input, init) => {
    const forwarded = forwardHeaders ? await forwardHeaders() : new Headers();
    const headers = new Headers(init?.headers);
    for (const name of allowlist) {
      const value = forwarded.get(name);
      if (value !== null) headers.set(name, value);
    }
    const request = app.request as HonoRequestFn;
    return request(input as Request | string, { ...init, headers });
  };
  return hc<AppType>("http://internal", { fetch: wrapped });
}
