/**
 * Trunk-composition smoke.
 *
 * Proves three things at once — everything a capability-slice commit
 * will assume when it plugs its route onto the trunk:
 *
 *   1. `app` responds to `/health`. The `OpenAPIHono().route('/', sub)`
 *      composition mounts the sub-app correctly.
 *   2. `testClient(app)` routes through the full app via typed RPC.
 *      Each capability's integration test can use the same pattern.
 *   3. `hc<AppType>('http://internal', { fetch: app.request.bind(app) })`
 *      works server-side with no TCP hop. This is the pattern ADR 0021
 *      names for Server Actions / RSC and server-to-server capability
 *      composition; proving it here means the next slice doesn't have
 *      to re-discover the header-forwarding + fetch-binding shape.
 *
 * If the top-level chain in `app.ts` ever regresses to
 * `app = app.route(...)` across statements, `client.health.$get` on
 * the typed clients below fails to compile — that's the regression
 * guard.
 */

import { hc } from "hono/client";
import { testClient } from "hono/testing";
import { describe, expect, it } from "vitest";

import { type AppType, app } from "./index";

describe("api-server trunk", () => {
  it("testClient → /health returns { status: 'ok', now: number }", async () => {
    const client = testClient(app);
    const res = await client.health.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.now).toBe("number");
  });

  it("hc<AppType> bound to app.request → same response (server-to-server path)", async () => {
    const client = hc<AppType>("http://internal", {
      fetch: app.request.bind(app),
    });
    const res = await client.health.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.now).toBe("number");
  });

  it("OpenAPI doc generator exposes the /health route", async () => {
    // `OpenAPIHono.getOpenAPIDocument` returns the spec without
    // mounting the `/doc` endpoint — useful in tests where we want to
    // assert the schema without going through a fetch.
    const doc = app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "editorzero api", version: "0.0.0" },
    });
    expect(doc.paths?.["/health"]?.get).toBeDefined();
    // biome-ignore lint/complexity/useLiteralKeys: tsconfig's noPropertyAccessFromIndexSignature (TS4111) forbids dot access on OpenAPI's `components.schemas` index signature.
    expect(doc.components?.schemas?.["HealthResponse"]).toBeDefined();
  });
});
