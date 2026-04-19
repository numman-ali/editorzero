/**
 * Trunk-composition smoke — **not** per-route behaviour.
 *
 * This file owns four concerns, each of which is a composition-layer
 * invariant that would break independently of any single route's logic:
 *
 *   1. The trunk's typed-RPC surface (`testClient(app)`) actually
 *      routes through the composed app. Any regression in `app.ts`
 *      (e.g., assignment-then-spread widening the tuple, or a
 *      reintroduced `.route('/', sub)` chain that collapses merge)
 *      fails this with a compile-time error on `client.infra.health.
 *      $get`.
 *   2. `hc<AppType>` bound to `app.request.bind(app)` dispatches
 *      server-side with no TCP hop. This is the pattern ADR 0021
 *      names for Server Actions / RSC and server-to-server capability
 *      composition — proving it here means the next slice doesn't
 *      have to re-discover the header-forwarding + fetch-binding
 *      shape.
 *   3. The mounted path matches the generated OpenAPI doc path. If a
 *      future slice introduces prefix-mounting (e.g., `.route('/v1',
 *      subApp)`) without updating the `createRoute({ path })` value
 *      on the route, the trunk would serve `/v1/infra/health` but
 *      the doc would advertise `/infra/health` — a silent divergence
 *      contract tests could miss. Asserting both against the same
 *      literal here is the cheapest guard.
 *   4. `createApiApp({ auth })` mounts the Better Auth handler on
 *      `/auth/*`. We only assert the mount boundary here — that a
 *      hand-crafted fake-auth instance receives calls intended for
 *      its handler — not Better Auth's protocol itself. The real
 *      auth stack is tested end-to-end in
 *      `composition/auth-chain.integration.test.ts`.
 *
 * Per-route behavioural tests (response shape, input validation, etc.)
 * live alongside each route at `routes/<domain>/<capability>/index.
 * unit.test.ts`. Do not bloat this file with per-route assertions;
 * keep it focused on composition-layer invariants.
 */

import type { Auth } from "@editorzero/auth";
import { hc } from "hono/client";
import { testClient } from "hono/testing";
import { describe, expect, it } from "vitest";

import { type AppType, app, createApiApp } from "./index";

const MOUNTED_PATH = "/infra/health" as const;

describe("api-server trunk composition", () => {
  it("testClient → /infra/health typed-RPC surface is preserved through the trunk merge", async () => {
    const client = testClient(app);
    const res = await client.infra.health.$get();
    expect(res.status).toBe(200);
  });

  it("hc<AppType>(app.request) — server-to-server path dispatches without TCP", async () => {
    const client = hc<AppType>("http://internal", {
      fetch: app.request.bind(app),
    });
    const res = await client.infra.health.$get();
    expect(res.status).toBe(200);
  });

  it("OpenAPI doc exposes the mounted path at exactly the folder-mirrored path", () => {
    // Guards the filesystem-as-routing-table invariant: if the mounted
    // path and generated-doc path ever diverge (e.g., a future prefix
    // mount that forgets to update `createRoute({ path })`), this fails
    // loud here instead of showing up as a downstream contract drift.
    const doc = app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "editorzero api", version: "0.0.0" },
    });
    expect(doc.paths?.[MOUNTED_PATH]?.get).toBeDefined();
    // biome-ignore lint/complexity/useLiteralKeys: tsconfig's noPropertyAccessFromIndexSignature (TS4111) forbids dot access on OpenAPI's `components.schemas` index signature.
    expect(doc.components?.schemas?.["HealthResponse"]).toBeDefined();
  });

  it("createApiApp({ auth }) routes POST /auth/* to auth.handler", async () => {
    // Composition-boundary assertion: any request matching `/auth/*`
    // reaches the injected Better Auth handler. Uses a fake auth object
    // typed as `Auth` so we don't spin up a real SQLite driver + Better
    // Auth instance just to assert the wiring. The full round-trip with
    // a real Better Auth instance is covered in
    // `composition/auth-chain.integration.test.ts`.
    let handlerCalls = 0;
    let seenUrl: string | undefined;
    let seenMethod: string | undefined;
    const fakeAuth = {
      handler: async (req: Request) => {
        handlerCalls += 1;
        seenUrl = req.url;
        seenMethod = req.method;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    } as unknown as Auth;

    const trunk = createApiApp({ auth: fakeAuth });
    const res = await trunk.request("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.com", password: "z" }),
    });
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("/auth/sign-in/email");

    // GET on /auth/* also reaches the handler (e.g. /auth/get-session).
    const getRes = await trunk.request("/auth/get-session");
    expect(getRes.status).toBe(200);
    expect(handlerCalls).toBe(2);
  });

  it("createApiApp() (no auth) does not mount the /auth/* route", async () => {
    // `/auth/*` is an auth-only path — when the factory is called
    // without auth, those paths should 404 (rather than silently
    // matching some default handler). This is the negative branch of
    // the `if (auth !== undefined)` guard in `createApiApp`.
    const trunk = createApiApp();
    const res = await trunk.request("/auth/sign-in/email", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
