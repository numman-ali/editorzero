/**
 * `createHttpClient` + `createServerClient` smoke.
 *
 * Both clients reduce to `hc<AppType>` shapes at the typed-RPC
 * surface; the tests below exercise the two composition boundaries
 * each client owns beyond raw `hc`:
 *
 *  - `createHttpClient`: `auth` resolver injects headers into every
 *    call; `fetch` override intercepts the request.
 *  - `createServerClient`: `forwardHeaders` allowlist copies exactly
 *    the permitted headers from the caller context (simulating
 *    Next's `next/headers()` in tests) into the synthesized Request.
 *
 * The `/infra/health` route lives on the api-server trunk; both
 * clients hit it end-to-end to prove the typed surface is exercised.
 * The RPC surface mirrors the URL structure — `client.infra.health.
 * $get()` corresponds to `GET /infra/health`. Keeping route-path
 * segments identifier-friendly (no hyphens, deliberate casing) is
 * what makes that dot-access shape clean; the filesystem-as-routing-
 * table convention preserves the property across the codebase.
 */

import { app } from "@editorzero/api-server";
import { describe, expect, it } from "vitest";

import { createHttpClient, createServerClient } from "./index";

function spyOnRequest(): {
  request: typeof app.request;
  lastHeaders: () => Headers | undefined;
} {
  let lastHeaders: Headers | undefined;
  const wrapped: typeof app.request = (input, requestInit, Env, executionCtx) => {
    lastHeaders = new Headers(requestInit?.headers);
    return app.request(input, requestInit, Env, executionCtx);
  };
  return { request: wrapped, lastHeaders: () => lastHeaders };
}

describe("createServerClient", () => {
  it("dispatches /infra/health through app.request end-to-end", async () => {
    const client = createServerClient({ app });
    const res = await client.infra.health.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.now).toBe("number");
  });

  it("forwards allowlisted headers from caller context (cookie + authorization)", async () => {
    // Simulate what next/headers() would hand the caller: a Headers
    // bag with a cookie and a bearer token. `createServerClient`
    // must copy *only* the allowlisted pair, not every header.
    const forwarded = new Headers({
      cookie: "session=abc",
      authorization: "Bearer token-123",
      "x-would-be-spoof": "should-not-pass-through",
    });
    const probe = spyOnRequest();
    const client = createServerClient({
      app: probe,
      forwardHeaders: () => forwarded,
    });
    const res = await client.infra.health.$get();
    expect(res.status).toBe(200);
    const seen = probe.lastHeaders();
    expect(seen?.get("cookie")).toBe("session=abc");
    expect(seen?.get("authorization")).toBe("Bearer token-123");
    expect(seen?.get("x-would-be-spoof")).toBeNull();
  });

  it("extends forward allowlist when additionalHeaders is provided", async () => {
    const forwarded = new Headers({
      cookie: "session=abc",
      "x-trace-id": "trace-xyz",
    });
    const probe = spyOnRequest();
    const client = createServerClient({
      app: probe,
      forwardHeaders: () => forwarded,
      additionalHeaders: ["x-trace-id"],
    });
    await client.infra.health.$get();
    expect(probe.lastHeaders()?.get("x-trace-id")).toBe("trace-xyz");
  });
});

describe("createHttpClient", () => {
  it("dispatches /infra/health through an injected fetch (real-fetch stand-in)", async () => {
    const client = createHttpClient({
      baseUrl: "http://test.local",
      fetch: app.request.bind(app) as typeof fetch,
    });
    const res = await client.infra.health.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.now).toBe("number");
  });

  it("sends credentials so the same-origin session cookie rides along", async () => {
    let seenCredentials: string | undefined;
    const probe: typeof fetch = async (input, init) => {
      seenCredentials = init?.credentials;
      return app.request(input as Request | string, init);
    };
    const client = createHttpClient({ baseUrl: "http://test.local", fetch: probe });
    const res = await client.infra.health.$get();
    expect(res.status).toBe(200);
    expect(seenCredentials).toBe("include");
  });

  it("auth resolver attaches its headers to every request", async () => {
    let seenAuth: string | null = null;
    const probe: typeof fetch = async (input, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return app.request(input as Request | string, init);
    };
    const client = createHttpClient({
      baseUrl: "http://test.local",
      auth: () => ({ authorization: "Bearer pat-xyz" }),
      fetch: probe,
    });
    const res = await client.infra.health.$get();
    expect(res.status).toBe(200);
    expect(seenAuth).toBe("Bearer pat-xyz");
  });

  it("supports async auth resolvers (rotating tokens)", async () => {
    let tokenVersion = 0;
    const seen: Array<string | null> = [];
    const probe: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return app.request(input as Request | string, init);
    };
    const client = createHttpClient({
      baseUrl: "http://test.local",
      auth: async () => {
        tokenVersion += 1;
        return { authorization: `Bearer v${tokenVersion}` };
      },
      fetch: probe,
    });
    await client.infra.health.$get();
    await client.infra.health.$get();
    expect(seen).toEqual(["Bearer v1", "Bearer v2"]);
  });
});
