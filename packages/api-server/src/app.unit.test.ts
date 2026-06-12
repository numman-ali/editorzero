/**
 * Trunk-composition smoke — **not** per-route behaviour.
 *
 * This file owns four concerns, each of which is a composition-layer
 * invariant that would break independently of any single route's logic:
 *
 *   1. The trunk's typed-RPC surface (`testClient(app)`) actually
 *      routes through the composed app. Any regression in `app.ts` or a
 *      domain index that breaks the fluent `.route()` chain (e.g.,
 *      assigning an intermediate mount to a `const` and re-mounting it,
 *      or a `for (const r of routes) trunk.route(...)` loop) drops the
 *      per-mount Schema accumulation and fails this with a compile-time
 *      error on `client.infra.health.$get`.
 *   2. `hc<AppType>` bound to `app.request.bind(app)` dispatches
 *      server-side with no TCP hop. This is the pattern ADR 0021
 *      names for Server Actions / RSC and server-to-server capability
 *      composition — proving it here means the next slice doesn't
 *      have to re-discover the header-forwarding + fetch-binding
 *      shape.
 *   3. The generated OpenAPI doc exposes each route at its
 *      prefix-mounted path. `generateSpecs(app)` statically walks the
 *      trunk's routes — including those merged through the two-level
 *      `.route(prefix, subApp)` mounts — and emits each at the path the
 *      mount actually serves (it reads the live `route.path`, so served
 *      path and doc path cannot drift by construction). This guards that
 *      the prefix is in fact applied in the spec: a regression that
 *      mounted a domain at the wrong prefix, or dropped a route from a
 *      domain index, surfaces here as a missing path.
 *   4. `createApiApp({ auth })` mounts the Better Auth handler on
 *      `/auth/*`. We only assert the mount boundary here — that a
 *      hand-crafted fake-auth instance receives calls intended for
 *      its handler — not Better Auth's protocol itself. The real
 *      auth stack is tested end-to-end in
 *      `composition/auth-chain.integration.test.ts`.
 *
 * Per-route behavioural tests (response shape, input validation, etc.)
 * live alongside each route at `routes/<domain>/<capability>.unit.test.ts`.
 * Do not bloat this file with per-route assertions; keep it focused on
 * composition-layer invariants.
 */

import type { Auth } from "@editorzero/auth";
import type { Registry } from "@editorzero/capabilities";
import { createRegistry } from "@editorzero/capabilities";
import type { LoadRoles } from "@editorzero/db";
import type { Dispatcher } from "@editorzero/dispatcher";
import { hc } from "hono/client";
import { testClient } from "hono/testing";
import { describe, expect, it } from "vitest";

import { type AppType, type AuthRevocation, app, createApiApp } from "./index";
import { openApiDocument } from "./lib/openapi";

function unreachable(message: string): never {
  throw new Error(message);
}

function makeFakeAuth(
  handler: Auth["handler"] = async () => new Response(),
  getSession: () => Promise<unknown> = async () => null,
): Auth {
  return {
    handler,
    api: {
      getSession,
    },
  } as Auth;
}

const emptyRegistry: Registry = createRegistry([]);

// Minimal Dispatcher stand-in for composition-boundary tests that need
// the triad guard satisfied but never actually dispatch. Never called
// on the `/auth/*` or `/infra/health` paths these tests exercise.
const fakeDispatcher: Dispatcher = {
  dispatch: async () => {
    throw new Error("fakeDispatcher.dispatch must not be called in these tests");
  },
  get deps() {
    return unreachable("fakeDispatcher.deps must not be read in these tests");
  },
};

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

  it("OpenAPI doc exposes the mounted paths at exactly the folder-mirrored paths", async () => {
    // Code-first spec (ADR 0029): `openApiDocument(app)` statically
    // walks the trunk's routes (`generateSpecs` under the hood) and
    // emits each at its prefix-mounted path.
    const doc = await openApiDocument(app);
    // `/infra/health` — single-level mount (trunk → `/infra` → `/health`).
    expect(doc.paths?.[MOUNTED_PATH]?.get).toBeDefined();
    // `/infra/whoami` (ADR 0025) shares the same `infra` domain sub-app —
    // so the doc must expose it at exactly the folder-mirrored path. The
    // runtime behaviour (auth-gated) is exercised in
    // `auth-chain.integration.test.ts`; this guards the path-mirror only.
    expect(doc.paths?.["/infra/whoami"]?.get).toBeDefined();
    // `/docs/create` — a capability route reached through the *two-level*
    // mount (trunk → `/docs` → route's `/create`). Proves nested
    // `.route()` composition surfaces in the spec with the prefix
    // applied, not just the trunk-direct `infra` domain.
    expect(doc.paths?.["/docs/create"]?.post).toBeDefined();
    // Response schemas inline into each operation — hono-openapi 1.3.0
    // does not extract named `components.schemas` from `.meta({ id })`
    // (see `lib/openapi.ts` + ADR 0029 §6). Assert the operation's 200
    // response is present (schema attached) rather than a named-component
    // `$ref` that the code-first substrate never emits.
    expect(doc.paths?.[MOUNTED_PATH]?.get?.responses?.["200"]).toBeDefined();
  });

  it("createApiApp({ auth, loadRoles, dispatcher }) routes POST /auth/* to auth.handler", async () => {
    // Composition-boundary assertion: any request matching `/auth/*`
    // reaches the injected Better Auth handler. Uses a fake auth object
    // typed as `Auth` so we don't spin up a real SQLite driver + Better
    // Auth instance just to assert the wiring. `loadRoles` is paired
    // with `auth` by the factory's runtime guard (ADR 0024); `dispatcher`
    // is required alongside them by the triad guard (partial shapes
    // mount `/docs/*` with missing middleware). None of the three is
    // actually called by `/auth/*` — they just satisfy the guards so
    // composition succeeds. The full round-trip with a real Better
    // Auth + loadRoles + dispatcher is covered in
    // `composition/auth-chain.integration.test.ts`.
    let handlerCalls = 0;
    let seenUrl: string | undefined;
    let seenMethod: string | undefined;
    const fakeAuth = makeFakeAuth(async (req: Request) => {
      handlerCalls += 1;
      seenUrl = req.url;
      seenMethod = req.method;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const fakeLoadRoles: LoadRoles = async () => {
      throw new Error("loadRoles must not be called when only /auth/* is exercised");
    };

    const trunk = createApiApp({
      auth: fakeAuth,
      loadRoles: fakeLoadRoles,
      dispatcher: fakeDispatcher,
    });
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

  it("createApiApp({ auth }) without loadRoles throws at composition time (ADR 0024 pairing)", () => {
    // ADR 0024: the resolver needs `loadRoles` to read `workspace_members`;
    // providing `auth` without it is a boot-time misconfiguration. Fail
    // loud here rather than at first request (where the failure would
    // surface as an unhelpful 500).
    const fakeAuth = makeFakeAuth();
    expect(() => createApiApp({ auth: fakeAuth })).toThrow(/auth.+without.+loadRoles/i);
  });

  it("createApiApp({ loadRoles }) without auth throws at composition time (ADR 0024 pairing)", () => {
    // Mirror of the previous guard: `loadRoles` is only consumed via the
    // auth resolver; providing it without `auth` is dead code and
    // almost certainly a caller bug.
    const fakeLoadRoles: LoadRoles = async () => null;
    expect(() => createApiApp({ loadRoles: fakeLoadRoles })).toThrow(/loadRoles.+without.+auth/i);
  });

  it("createApiApp({ registry }) without dispatcher throws (ADR 0026 MCP mount)", () => {
    // The MCP handler closes over the dispatcher; mounting `/mcp` with
    // only a registry would advertise tool calls with no execution
    // path. Fail loud at boot rather than at first tools/call.
    expect(() => createApiApp({ registry: emptyRegistry })).toThrow(
      /registry.+without.+dispatcher/i,
    );
  });

  it("createApiApp({ auth, loadRoles }) without dispatcher throws (triad invariant)", () => {
    // `/docs/*` routes mount unconditionally and read `c.var.dispatcher`
    // in-handler. Without the dispatcher middleware the first request
    // would crash with TypeError — caught loud at boot instead.
    const fakeAuth = makeFakeAuth();
    const fakeLoadRoles: LoadRoles = async () => null;
    expect(() => createApiApp({ auth: fakeAuth, loadRoles: fakeLoadRoles })).toThrow(
      /auth.+without.+dispatcher/i,
    );
  });

  it("createApiApp({ dispatcher }) without auth throws (triad invariant)", () => {
    // Mirror: `/docs/*` handlers read `c.var.principal` set by the
    // principal middleware, which only attaches under the auth pair.
    // Providing dispatcher alone would crash on first request.
    expect(() => createApiApp({ dispatcher: fakeDispatcher })).toThrow(
      /dispatcher.+without.+auth/i,
    );
  });

  it("createApiApp({ registry, dispatcher }) without auth throws (ADR 0026 slice 1)", () => {
    // Slice 1 of the MCP adapter reads principal via the cookie chain;
    // without auth + loadRoles there is no principal middleware on
    // `/mcp` and every tool call would crash reading `c.var.principal`.
    // Require the full auth stack at composition time.
    expect(() => createApiApp({ registry: emptyRegistry, dispatcher: fakeDispatcher })).toThrow(
      /registry.+without.+auth/i,
    );
  });

  // ── Auth-revocation tap (ADR 0043 Decision 5, sign-out arm) ─────────────
  //
  // The `/auth/*` mount wraps Better Auth's handler: when a
  // revocation-class endpoint succeeds, `onAuthRevoked` reports what was
  // revoked so the composition root can close the matching collab
  // sockets. These tests pin the wrap's contract at the mount boundary
  // with a fake auth; the live flow — an attached WS closed by a real
  // sign-out — is integration-tested in apps/server's cohost suite.

  const WS_RAW = "018f0000-0000-7000-8000-00000000aaa1";
  const USER_RAW = "018f0000-0000-7000-8000-00000000aaa2";
  const SESSION_RAW = "018f0000-0000-7000-8000-00000000aaa3";

  function makeSessionAuth(handler?: Auth["handler"]): Auth {
    return makeFakeAuth(handler ?? (async () => new Response(null, { status: 200 })), async () => ({
      session: { id: SESSION_RAW },
      user: { id: USER_RAW, workspaceId: WS_RAW },
    }));
  }
  const memberLoadRoles: LoadRoles = async () => ["member"];

  function buildRevocationTrunk(options: {
    auth: Auth;
    onAuthRevoked: (revocation: AuthRevocation) => void;
  }) {
    return createApiApp({
      auth: options.auth,
      loadRoles: memberLoadRoles,
      dispatcher: fakeDispatcher,
      onAuthRevoked: options.onAuthRevoked,
    });
  }

  it("createApiApp({ onAuthRevoked }) without auth throws (the tap rides /auth/*)", () => {
    expect(() => createApiApp({ onAuthRevoked: () => undefined })).toThrow(
      /onAuthRevoked.+without.+auth/i,
    );
  });

  it("POST /auth/sign-out fires onAuthRevoked({ kind: 'session' }) only after the handler confirms", async () => {
    const order: string[] = [];
    const revocations: AuthRevocation[] = [];
    const trunk = buildRevocationTrunk({
      auth: makeSessionAuth(async () => {
        order.push("handler");
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }),
      onAuthRevoked: (revocation) => {
        order.push("revoked");
        revocations.push(revocation);
      },
    });
    const res = await trunk.request("/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(200);
    expect(order).toEqual(["handler", "revoked"]);
    expect(revocations).toEqual([{ kind: "session", session_id: SESSION_RAW }]);
  });

  it("POST /auth/revoke-sessions and /auth/revoke-other-sessions fire { kind: 'user' }", async () => {
    for (const path of ["/auth/revoke-sessions", "/auth/revoke-other-sessions"]) {
      const revocations: AuthRevocation[] = [];
      const trunk = buildRevocationTrunk({
        auth: makeSessionAuth(),
        onAuthRevoked: (revocation) => revocations.push(revocation),
      });
      const res = await trunk.request(path, { method: "POST" });
      expect(res.status).toBe(200);
      expect(revocations).toEqual([{ kind: "user", user_id: USER_RAW }]);
    }
  });

  it("does not fire when Better Auth refuses the revocation (response not ok)", async () => {
    const revocations: AuthRevocation[] = [];
    const trunk = buildRevocationTrunk({
      auth: makeSessionAuth(async () => new Response("nope", { status: 400 })),
      onAuthRevoked: (revocation) => revocations.push(revocation),
    });
    const res = await trunk.request("/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(400);
    expect(revocations).toEqual([]);
  });

  it("does not fire for an unauthenticated caller, and never blocks the handler", async () => {
    const revocations: AuthRevocation[] = [];
    const trunk = buildRevocationTrunk({
      // Default `getSession` resolves null — no principal to report.
      auth: makeFakeAuth(async () => new Response(null, { status: 200 })),
      onAuthRevoked: (revocation) => revocations.push(revocation),
    });
    const res = await trunk.request("/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(200);
    expect(revocations).toEqual([]);
  });

  it("a throwing onAuthRevoked never turns a committed revocation into a 5xx", async () => {
    const trunk = buildRevocationTrunk({
      auth: makeSessionAuth(),
      onAuthRevoked: () => {
        throw new Error("registry exploded");
      },
    });
    const res = await trunk.request("/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("non-revocation auth traffic passes through without a session resolution", async () => {
    // The wrap must not add a getSession round-trip to hot auth paths
    // (sign-in, get-session) — only revocation-class POSTs resolve.
    let sessionReads = 0;
    const revocations: AuthRevocation[] = [];
    const auth = makeFakeAuth(
      async () => new Response(null, { status: 200 }),
      async () => {
        sessionReads += 1;
        return null;
      },
    );
    const trunk = buildRevocationTrunk({
      auth,
      onAuthRevoked: (revocation) => revocations.push(revocation),
    });
    await trunk.request("/auth/sign-in/email", { method: "POST" });
    await trunk.request("/auth/get-session");
    expect(sessionReads).toBe(0);
    expect(revocations).toEqual([]);
  });

  // ── Global error mapper (trunk.onError) ────────────────────────────────
  //
  // The mapper is the lone surface-boundary that turns thrown errors
  // into structured HTTP responses. Three branches:
  //   1. `EditorZeroError` subclass → `{ error: err.code }` with the
  //      subclass's declared `httpStatus`.
  //   2. PG retryable-serialization error (`.code === "40001" | "40P01"`)
  //      → `{ error: "conflict" }` with 409. Surfaces the loser of a
  //      SERIALIZABLE race as a typed conflict rather than a raw 500
  //      (ADR 0023 §3; bounded retry deferred).
  //   3. Anything else → rethrown (Hono default → 500).
  //
  // These tests drive errors through the trunk by having a fake auth
  // handler throw — `/auth/*` is attached before routes but after
  // `trunk.onError`, so a throw here exercises the same mapper path
  // any capability handler would hit.

  const makeFaultyAuth = (err: unknown): Auth =>
    makeFakeAuth(async () => {
      throw err;
    });
  const fakeLoadRoles: LoadRoles = async () => null;

  function buildTrunkWithFaultyAuth(err: unknown) {
    return createApiApp({
      auth: makeFaultyAuth(err),
      loadRoles: fakeLoadRoles,
      dispatcher: fakeDispatcher,
    });
  }

  it("global mapper projects PG 40001 (serialization_failure) to 409 `conflict`", async () => {
    const pgError = Object.assign(new Error("SSI abort"), { code: "40001" });
    const trunk = buildTrunkWithFaultyAuth(pgError);
    const res = await trunk.request("/auth/sign-in/email", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
  });

  it("global mapper projects PG 40P01 (deadlock_detected) to 409 `conflict`", async () => {
    const pgError = Object.assign(new Error("deadlock"), { code: "40P01" });
    const trunk = buildTrunkWithFaultyAuth(pgError);
    const res = await trunk.request("/auth/sign-in/email", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
  });

  it("global mapper does not swallow unrelated PG-shaped errors (e.g. unique_violation `23505`)", async () => {
    // Only retryable-serialization codes map to 409; other pg codes
    // (e.g. 23505 unique_violation) belong to the throwing layer's own
    // error family and should either be projected through EditorZeroError
    // (e.g. SlugCollisionError) or rethrow. The mapper must not silently
    // turn every PG error into a 409 — that would hide real capability-
    // side bugs. In this test harness the rethrow propagates past
    // `trunk.request(...)` (no outer HTTP server catching it to 500); in
    // production Node/Hono's default handler converts it to a 500 for the
    // caller. Either way, the mapper is NOT the thing that sends 409.
    const pgError = Object.assign(new Error("unique violation"), { code: "23505" });
    const trunk = buildTrunkWithFaultyAuth(pgError);
    await expect(trunk.request("/auth/sign-in/email", { method: "POST" })).rejects.toThrow(
      /unique violation/,
    );
  });

  it("global mapper projects EditorZeroError subclasses using `code` + `httpStatus`", async () => {
    // Sanity-pin the typed branch — the one the rest of the app depends
    // on for every 400/401/403/404/409/413 response shape.
    const { ConflictError } = await import("@editorzero/errors");
    const trunk = buildTrunkWithFaultyAuth(
      new ConflictError({ message: "synthetic", retry_after_ms: null }),
    );
    const res = await trunk.request("/auth/sign-in/email", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
  });

  it("global mapper rethrows bare (non-typed, non-PG) errors to the default handler", async () => {
    // Surface-contract: random uncategorized errors are NOT silently
    // projected to a successful response. Same harness caveat as the
    // unrelated-pg test above — in production the rethrow becomes a 500.
    const trunk = buildTrunkWithFaultyAuth(new Error("unclassified boom"));
    await expect(trunk.request("/auth/sign-in/email", { method: "POST" })).rejects.toThrow(
      /unclassified boom/,
    );
  });
});
