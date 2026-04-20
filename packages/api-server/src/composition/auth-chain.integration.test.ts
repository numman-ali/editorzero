/**
 * Full auth chain integration test — trunk + Better Auth + principal
 * middleware + dispatcher middleware against a real in-memory SQLite
 * driver.
 *
 * The unit tests in `middleware/principal.unit.test.ts`,
 * `middleware/dispatcher.unit.test.ts`, `auth/create-auth.integration.
 * test.ts`, and `app.unit.test.ts` each pin one seam of the auth chain.
 * This file proves the composition works *together*:
 *
 *   1. `createApiApp({ auth, dispatcher })` returns a trunk that
 *      serves Better Auth's `/auth/*` endpoints live against the
 *      shared SQLite DB.
 *   2. `POST /auth/sign-up/email` → user row with minted
 *      `workspaceId`, HTTP 200.
 *   3. `POST /auth/sign-in/email` → `Set-Cookie: better-auth.
 *      session_token=...` on the response.
 *   4. A request carrying that cookie through
 *      `createPrincipalMiddleware({ resolve: createBetterAuthResolver(
 *      auth) })` materialises a `UserPrincipal` on `c.var.principal`
 *      with the matching `workspace_id`.
 *   5. The same request carries a `Dispatcher` on `c.var.dispatcher`
 *      via `createDispatcherMiddleware`, so a capability route that
 *      reads `c.var.dispatcher` can invoke capabilities.
 *
 * The "capability route" here is a test-only probe mounted on the
 * trunk post-factory. That's intentional — we're proving the
 * *middleware composition* works end-to-end today. The first real
 * capability route lands in the next slice and reuses this exact
 * composition shape.
 */

import { createAuth, createBetterAuthResolver, runAuthMigrations } from "@editorzero/auth";
import {
  createRegistry,
  docCreate,
  docGet,
  docList,
  docPublish,
  docUnpublish,
  registerCapability,
} from "@editorzero/capabilities";
import {
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createSqliteDriver,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { DocId, UserId } from "@editorzero/ids";
import { HocuspocusSync } from "@editorzero/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiApp } from "../app";
import { createDispatcherMiddleware } from "../middleware/dispatcher";
import { createPrincipalMiddleware } from "../middleware/principal";
import { createApiDispatcher } from "./createApiDispatcher";

let driver: SqliteDriver;
const openSyncs: HocuspocusSync[] = [];

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  while (openSyncs.length > 0) {
    const sync = openSyncs.pop();
    if (sync !== undefined) await sync.close();
  }
  await driver.close();
});

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie
    .split(/,(?=\s*[^ ;]+=)/u)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}

async function buildStack(
  options: {
    registerDocList?: boolean;
    registerDocCreate?: boolean;
    registerDocGet?: boolean;
    registerDocPublish?: boolean;
    registerDocUnpublish?: boolean;
    withSync?: boolean;
  } = {},
) {
  const auth = createAuth({
    driver,
    baseURL: "http://localhost:3000",
    secret: "test-secret-do-not-use-in-production-at-all",
    trustedOrigins: ["http://localhost:3000"],
  });
  await runAuthMigrations(auth);
  // Registry is empty by default (the probe route exercises middleware-
  // only scenarios). Each end-to-end test opts in to the capabilities
  // it exercises so the dispatcher only routes registered ones.
  const capabilities = [
    ...(options.registerDocList ? [registerCapability(docList)] : []),
    ...(options.registerDocCreate ? [registerCapability(docCreate)] : []),
    ...(options.registerDocGet ? [registerCapability(docGet)] : []),
    ...(options.registerDocPublish ? [registerCapability(docPublish)] : []),
    ...(options.registerDocUnpublish ? [registerCapability(docUnpublish)] : []),
  ];
  const registry = createRegistry(capabilities);
  // Content-mutation capabilities (doc.create) need a real
  // HocuspocusSync bound into the dispatcher so `ctx.transact`
  // persists the seed-blocks update to `doc_updates` inside the
  // write-path tx. Tests that exercise read-only capabilities skip
  // sync for a smaller blast radius.
  const sync =
    options.withSync === true
      ? new HocuspocusSync({
          docUpdatesWriter: createDocUpdatesWriter(),
          docUpdatesReader: createDocUpdatesReader(),
          systemDb: driver.system(),
        })
      : undefined;
  if (sync !== undefined) openSyncs.push(sync);
  const dispatcher = createApiDispatcher(
    sync === undefined ? { driver, registry } : { driver, registry, sync },
  );
  const trunk = createApiApp({ auth, dispatcher });
  return { auth, dispatcher, trunk };
}

async function signUp(trunk: Awaited<ReturnType<typeof buildStack>>["trunk"], email: string) {
  return trunk.request("/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "correct-horse-battery-staple",
      name: email.split("@")[0],
    }),
  });
}

async function signIn(trunk: Awaited<ReturnType<typeof buildStack>>["trunk"], email: string) {
  return trunk.request("/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
}

describe("api-server auth chain (trunk + Better Auth + middleware)", () => {
  it("sign-up through the trunk creates a user row with a minted workspaceId", async () => {
    const { trunk } = await buildStack();
    const res = await signUp(trunk, "alice@example.com");
    expect(res.status).toBe(200);

    const users = await driver
      .system()
      // biome-ignore lint/suspicious/noExplicitAny: Better Auth's `user` table is outside our Database type.
      .selectFrom("user" as any)
      .select(["email" as never, "workspaceId" as never])
      .execute();
    expect(users).toHaveLength(1);
    const user = users[0] as { email: string; workspaceId: string };
    expect(user.email).toBe("alice@example.com");
    expect(user.workspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
  });

  it("sign-in through the trunk returns a session cookie the resolver can consume", async () => {
    const { auth, trunk } = await buildStack();
    await signUp(trunk, "bob@example.com");

    const signInRes = await signIn(trunk, "bob@example.com");
    expect(signInRes.status).toBe(200);

    const cookie = sessionCookieFrom(signInRes);
    expect(cookie).toContain("session_token");

    const resolver = createBetterAuthResolver(auth);
    const principal = await resolver(new Headers({ cookie }));
    expect(principal).not.toBeNull();
    if (principal === null) throw new Error("unreachable");
    expect(principal.kind).toBe("user");
    expect(principal.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
  });

  it("principal + dispatcher middleware attach to c.var for an authenticated probe route", async () => {
    const { auth, dispatcher, trunk } = await buildStack();
    // Mount the probe BEFORE the first request — Hono's SmartRouter
    // lazily builds its match tree on first request, and once built it
    // refuses further `.use()` / `.get()` calls. Real capability routes
    // compose through `openapiRoutes([...] as const)` at factory time,
    // so they land before any request too. This test uses the same
    // mount-early discipline.
    trunk.use(
      "/probe",
      createPrincipalMiddleware({
        resolve: (c) => createBetterAuthResolver(auth)(c.req.raw.headers),
      }),
    );
    trunk.use("/probe", createDispatcherMiddleware({ dispatcher }));
    trunk.get("/probe", (c) => {
      const principal = c.var.principal;
      const hasDispatcher = typeof c.var.dispatcher.dispatch === "function";
      if (principal.kind !== "user") {
        return c.json({ ok: false as const, reason: "not-user" });
      }
      return c.json({
        ok: true as const,
        workspace_id: principal.workspace_id,
        has_dispatcher: hasDispatcher,
      });
    });

    await signUp(trunk, "carol@example.com");
    const signInRes = await signIn(trunk, "carol@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const probeRes = await trunk.request("/probe", { headers: { cookie } });
    expect(probeRes.status).toBe(200);
    const body = (await probeRes.json()) as {
      ok: boolean;
      workspace_id: string;
      has_dispatcher: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
    expect(body.has_dispatcher).toBe(true);
  });

  it("principal middleware returns 401 when no session cookie is present", async () => {
    const { auth, dispatcher, trunk } = await buildStack();
    trunk.use(
      "/probe",
      createPrincipalMiddleware({
        resolve: (c) => createBetterAuthResolver(auth)(c.req.raw.headers),
      }),
    );
    trunk.use("/probe", createDispatcherMiddleware({ dispatcher }));
    trunk.get("/probe", (c) => c.json({ ok: true }));

    const res = await trunk.request("/probe");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  it("GET /docs/list round-trips through the full stack (auth → principal mw → dispatcher → doc.list capability)", async () => {
    const { trunk } = await buildStack({ registerDocList: true });
    await signUp(trunk, "dana@example.com");
    const signInRes = await signIn(trunk, "dana@example.com");
    const cookie = sessionCookieFrom(signInRes);

    // Resolve the principal once to discover the minted workspace_id
    // so we can seed a docs row inside that tenant.
    const principal = await createBetterAuthResolver(
      createAuth({
        driver,
        baseURL: "http://localhost:3000",
        secret: "test-secret-do-not-use-in-production-at-all",
        trustedOrigins: ["http://localhost:3000"],
      }),
    )(new Headers({ cookie }));
    if (principal === null) throw new Error("unexpected null principal after sign-in");
    const workspace_id = principal.workspace_id;

    // Seed a docs row directly via the driver for the list round-trip —
    // this test owns the *read-path* composition (no sync wired). A
    // separate test below exercises `POST /docs/create` → `GET /docs/list`
    // with `withSync: true` so the list read sees the written row.
    await driver.withSystemTx(async (tx) => {
      await tx
        .insertInto("docs")
        .values({
          id: DocId("018f0000-0000-7000-8000-0000000000d1"),
          workspace_id,
          collection_id: null,
          title: "My first doc",
          slug: "my-first-doc",
          order_key: "a",
          visibility: "workspace",
          visibility_version: 0,
          created_by: UserId(principal.id),
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
          deleted_at: null,
        })
        .execute();
    });

    const res = await trunk.request("/docs/list", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      docs: ReadonlyArray<{ id: string; title: string; visibility: string }>;
    };
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]?.title).toBe("My first doc");
    expect(body.docs[0]?.visibility).toBe("workspace");
  });

  it("GET /docs/list 401s when no session cookie is present", async () => {
    const { trunk } = await buildStack({ registerDocList: true });
    const res = await trunk.request("/docs/list");
    expect(res.status).toBe(401);
  });

  it("GET /docs/list of a different workspace returns an empty list (tenant isolation)", async () => {
    // Two tenants, one doc per tenant. Dana hits /docs/list; she
    // should see ONLY her own workspace's doc, not Eve's. This
    // proves the `WorkspaceScopingPlugin` + principal-workspace_id
    // chain correctly isolates reads (invariant 5 + ADR 0023 §3.2).
    const { trunk } = await buildStack({ registerDocList: true });
    await signUp(trunk, "dana@example.com");
    await signUp(trunk, "eve@example.com");
    const danaSignIn = await signIn(trunk, "dana@example.com");
    const danaCookie = sessionCookieFrom(danaSignIn);
    const eveSignIn = await signIn(trunk, "eve@example.com");
    const eveCookie = sessionCookieFrom(eveSignIn);

    const resolver = createBetterAuthResolver(
      createAuth({
        driver,
        baseURL: "http://localhost:3000",
        secret: "test-secret-do-not-use-in-production-at-all",
        trustedOrigins: ["http://localhost:3000"],
      }),
    );
    const danaPrincipal = await resolver(new Headers({ cookie: danaCookie }));
    const evePrincipal = await resolver(new Headers({ cookie: eveCookie }));
    if (danaPrincipal === null || evePrincipal === null) {
      throw new Error("unexpected null principal");
    }
    expect(danaPrincipal.workspace_id).not.toBe(evePrincipal.workspace_id);

    // Seed docs in each workspace.
    await driver.withSystemTx(async (tx) => {
      await tx
        .insertInto("docs")
        .values([
          {
            id: DocId("018f0000-0000-7000-8000-0000000000d1"),
            workspace_id: danaPrincipal.workspace_id,
            collection_id: null,
            title: "Dana's doc",
            slug: "dana-doc",
            order_key: "a",
            visibility: "workspace",
            visibility_version: 0,
            created_by: UserId(danaPrincipal.id),
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          },
          {
            id: DocId("018f0000-0000-7000-8000-0000000000d2"),
            workspace_id: evePrincipal.workspace_id,
            collection_id: null,
            title: "Eve's doc",
            slug: "eve-doc",
            order_key: "a",
            visibility: "workspace",
            visibility_version: 0,
            created_by: UserId(evePrincipal.id),
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          },
        ])
        .execute();
    });

    const danaRes = await trunk.request("/docs/list", { headers: { cookie: danaCookie } });
    expect(danaRes.status).toBe(200);
    const danaBody = (await danaRes.json()) as {
      docs: ReadonlyArray<{ title: string }>;
    };
    expect(danaBody.docs).toHaveLength(1);
    expect(danaBody.docs[0]?.title).toBe("Dana's doc");
  });

  it("POST /docs/create mints a doc; GET /docs/list returns it (full write-path round-trip)", async () => {
    // End-to-end write-path test: Better Auth → principal middleware →
    // dispatcher middleware → createApiDispatcher (with HocuspocusSync
    // wired) → doc.create handler → seedBlocks through ctx.transact →
    // doc_updates + audit rows commit in one tx. Then GET /docs/list
    // reads back the freshly-created doc from the tenant-scoped
    // `docs` view.
    const { trunk } = await buildStack({
      registerDocList: true,
      registerDocCreate: true,
      withSync: true,
    });
    await signUp(trunk, "frank@example.com");
    const signInRes = await signIn(trunk, "frank@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Frank's first doc" }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      doc_id: string;
      workspace_id: string;
      title: string;
      slug: string;
      seed_blocks: ReadonlyArray<{ id: string; type: string }>;
    };
    expect(createBody.title).toBe("Frank's first doc");
    expect(createBody.slug).toBe("frank-s-first-doc");
    expect(createBody.seed_blocks).toHaveLength(2);
    expect(createBody.seed_blocks[0]?.type).toBe("heading");
    expect(createBody.seed_blocks[1]?.type).toBe("paragraph");
    expect(createBody.doc_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);

    // Durable state: one `doc_updates` row landed inside the write-
    // path tx (proves ctx.transact is wired through HocuspocusSync).
    const updates = await driver
      .system()
      .selectFrom("doc_updates")
      .select(["seq", "doc_id"])
      .execute();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.doc_id).toBe(createBody.doc_id);

    // Read-path round-trip: the new doc shows up in /docs/list.
    const listRes = await trunk.request("/docs/list", { headers: { cookie } });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      docs: ReadonlyArray<{ id: string; title: string }>;
    };
    expect(listBody.docs).toHaveLength(1);
    expect(listBody.docs[0]?.id).toBe(createBody.doc_id);
    expect(listBody.docs[0]?.title).toBe("Frank's first doc");

    // Audit trail: one allow row per call (create + list). The read
    // collapses on identical inputs, but this test only hits list
    // once — no collapsing is expected.
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .orderBy("created_at")
      .execute();
    expect(audits).toHaveLength(2);
    expect(audits[0]?.capability_id).toBe("doc.create");
    expect(audits[0]?.outcome).toBe("allow");
    expect(audits[1]?.capability_id).toBe("doc.list");
    expect(audits[1]?.outcome).toBe("allow");
  });

  it("POST /docs/create 401s without a session cookie", async () => {
    const { trunk } = await buildStack({
      registerDocCreate: true,
      withSync: true,
    });
    const res = await trunk.request("/docs/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /docs/create with empty title returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocCreate: true,
      withSync: true,
    });
    await signUp(trunk, "grace@example.com");
    const signInRes = await signIn(trunk, "grace@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);

    // No audit row — the zod validator rejected the body before the
    // dispatcher was invoked (route-level `.strict()` is stricter than
    // the capability's own input schema would reach).
    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/create → GET /docs/get/:doc_id returns the freshly-minted doc with seed blocks", async () => {
    // End-to-end read-path test. Create mints the doc + seeds
    // blocks via ctx.transact on the write path; the resulting
    // doc_updates row is the durable state. The get read-path must
    // hydrate the Y.Doc via sync.read (onLoadDocument →
    // readByDocUntransacted → applyUpdate onto a clone) so the
    // handler's readBlocks projection returns the header +
    // paragraph the writer seeded. This test covers every layer of
    // the P3.7 stack: auth → principal mw → dispatcher mw →
    // createApiDispatcher → runRead → sync.read → capability
    // handler → readBlocks → route response.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocGet: true,
      withSync: true,
    });
    await signUp(trunk, "henry@example.com");
    const signInRes = await signIn(trunk, "henry@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Henry's doc" }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      doc_id: string;
      title: string;
      seed_blocks: ReadonlyArray<{ id: string; type: string }>;
    };

    const getRes = await trunk.request(`/docs/get/${createBody.doc_id}`, { headers: { cookie } });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      doc: { id: string; title: string; visibility: string };
      blocks: ReadonlyArray<{ id: string; type: string }>;
    };

    expect(getBody.doc.id).toBe(createBody.doc_id);
    expect(getBody.doc.title).toBe("Henry's doc");
    expect(getBody.doc.visibility).toBe("workspace");
    // The seed blocks the writer inserted (heading + paragraph) must
    // project out of the Y.Doc clone. Identity-matching on block IDs
    // proves the hydration applied the committed doc_updates row —
    // a broken read would return [] or different IDs.
    expect(getBody.blocks.map((b) => b.type)).toEqual(["heading", "paragraph"]);
    expect(getBody.blocks.map((b) => b.id)).toEqual(createBody.seed_blocks.map((b) => b.id));
  });

  it("GET /docs/get/:doc_id for a missing doc returns 404", async () => {
    // NotFoundError from the capability projects through the error
    // mapper to HTTP 404. doc.get's "not present OR soft-deleted"
    // branch — caller sees `not_found` either way (header comment in
    // doc/get.ts explains why a 410 for soft-deletes would leak
    // trash-visibility to readers without delete permission).
    const { trunk } = await buildStack({
      registerDocGet: true,
      withSync: true,
    });
    await signUp(trunk, "iris@example.com");
    const signInRes = await signIn(trunk, "iris@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const missing = "018f0000-0000-7000-8000-0000000000e9";
    const res = await trunk.request(`/docs/get/${missing}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("GET /docs/get/:doc_id 401s without a session cookie", async () => {
    const { trunk } = await buildStack({
      registerDocGet: true,
      withSync: true,
    });
    const res = await trunk.request("/docs/get/018f0000-0000-7000-8000-0000000000a1");
    expect(res.status).toBe(401);
  });

  it("GET /docs/get/:doc_id with a non-UUID param returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocGet: true,
      withSync: true,
    });
    await signUp(trunk, "jack@example.com");
    const signInRes = await signIn(trunk, "jack@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/get/not-a-uuid", { headers: { cookie } });
    expect(res.status).toBe(400);

    // No audit row — route-level zod param validation rejected before
    // the dispatcher was invoked.
    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("GET /docs/get/:doc_id for a doc in a different workspace returns 404 (tenant isolation)", async () => {
    // Eve creates a doc; Kate (a different tenant) queries it by id.
    // The `WorkspaceScopingPlugin` auto-injects Kate's `workspace_id`
    // predicate on the SELECT inside doc.get's handler — the row is
    // invisible, the handler throws NotFoundError, and Kate sees a
    // plain 404 with no "yes this exists but is not yours" signal.
    // Regression guard on cross-workspace read isolation (invariant 5
    // + ADR 0023 §3.2); same class of isolation already proven on
    // doc.list, re-proven here so doc.get's path-param shape doesn't
    // accidentally bypass the plugin's predicate.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocGet: true,
      withSync: true,
    });
    await signUp(trunk, "eve2@example.com");
    const eveSignIn = await signIn(trunk, "eve2@example.com");
    const eveCookie = sessionCookieFrom(eveSignIn);
    await signUp(trunk, "kate@example.com");
    const kateSignIn = await signIn(trunk, "kate@example.com");
    const kateCookie = sessionCookieFrom(kateSignIn);

    // Eve creates a doc.
    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie: eveCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Eve's private doc" }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { doc_id: string };

    // Kate tries to read it by id.
    const kateRes = await trunk.request(`/docs/get/${createBody.doc_id}`, {
      headers: { cookie: kateCookie },
    });
    expect(kateRes.status).toBe(404);
  });

  // ── POST /docs/publish/:doc_id — first metadata-only mutation ────────
  //
  // End-to-end coverage for the publish route scopes down to what the
  // real Better Auth stack can actually exercise. The resolver hardcodes
  // `roles: ["member"]` (see `@editorzero/auth` → `resolver.ts`), and
  // `member` role's `ROLE_SCOPES` (dispatcher/src/gate.ts) does NOT
  // include `doc:publish` — so every real authenticated caller today
  // hits the gate's deny branch. The happy-path allow test lands when
  // the `workspace_members` slice ships role widening to `admin` / `owner`
  // (resolver.ts header comment). Route unit test + capability unit
  // test cover the allow behaviour at lower layers.
  it("POST /docs/publish/:doc_id 401s without a session cookie", async () => {
    const { trunk } = await buildStack({
      registerDocPublish: true,
    });
    const res = await trunk.request("/docs/publish/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("POST /docs/publish/:doc_id with a non-UUID param returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocPublish: true,
    });
    await signUp(trunk, "liam@example.com");
    const signInRes = await signIn(trunk, "liam@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/publish/not-a-uuid", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(400);

    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/publish/:doc_id 403s for a member role (no doc:publish scope)", async () => {
    // Proves the scope gate fires for a real authenticated member.
    // Better Auth's resolver minted a `member` principal; the
    // dispatcher's `PermissionGate` denies because `member`'s
    // ROLE_SCOPES set doesn't include `doc:publish`. Deny-audit row
    // lands via `withAuditTx` — a separate short-lived tx from any
    // write-path, so we see `outcome: "deny"` even though the handler
    // never ran. The doc doesn't need to exist (gate runs before the
    // handler's SELECT); any valid UUIDv7 exercises the gate.
    const { trunk } = await buildStack({
      registerDocPublish: true,
    });
    await signUp(trunk, "mia@example.com");
    const signInRes = await signIn(trunk, "mia@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/publish/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(403);

    // One deny audit row lands; no allow, no rename mutation.
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.capability_id).toBe("doc.publish");
    expect(audits[0]?.outcome).toBe("deny");
  });

  it("POST /docs/publish/:doc_id for a doc in a different workspace denies before reaching the SELECT (scope gate fires first)", async () => {
    // Cross-workspace protection on doc.publish is owned by two layers:
    // (a) the dispatcher's scope gate (member lacks `doc:publish`, so
    // the deny fires here before the handler), and (b) the tenant-
    // scoped `ctx.db` with `WorkspaceScopingPlugin` (if the gate ever
    // allowed the handler to run, the SELECT-on-UPDATE would return 0
    // rows for cross-workspace targets → 404). Today only (a) is
    // observable because every authenticated user is a member. When
    // role widening lands, a follow-up test on the allow path will
    // exercise (b) with an admin principal.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocPublish: true,
      withSync: true,
    });
    await signUp(trunk, "nora@example.com");
    const noraSignIn = await signIn(trunk, "nora@example.com");
    const noraCookie = sessionCookieFrom(noraSignIn);
    await signUp(trunk, "oscar@example.com");
    const oscarSignIn = await signIn(trunk, "oscar@example.com");
    const oscarCookie = sessionCookieFrom(oscarSignIn);

    // Nora creates a doc.
    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie: noraCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Nora's doc" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    // Oscar tries to publish it. Gate denies (member role).
    const res = await trunk.request(`/docs/publish/${doc_id}`, {
      method: "POST",
      headers: { cookie: oscarCookie },
    });
    expect(res.status).toBe(403);

    // Confirm the row was not mutated — visibility still "workspace",
    // visibility_version still 0. `driver.system()` is typed against
    // the real schema, so the id column wants a `DocId` brand; the
    // wire-form string off `createBody.doc_id` needs to be re-branded
    // via the idempotent `DocId()` factory (already a valid UUIDv7
    // string from the create handler).
    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["visibility", "visibility_version"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.visibility).toBe("workspace");
    expect(row.visibility_version).toBe(0);
  });

  // ── POST /docs/unpublish/:doc_id — inverse of publish ────────────────
  //
  // Shares publish's authz envelope: scope `doc:publish`, member role
  // lacks it, real Better Auth resolver hardcodes members. So every
  // authenticated caller today hits the gate's deny branch; the happy-
  // path allow lands when `workspace_members` widens roles (resolver.ts
  // header comment). Only the deny / missing-auth / malformed-param
  // branches are reachable here; the allow branch is covered by the
  // route unit test + capability unit test at lower layers.
  it("POST /docs/unpublish/:doc_id 401s without a session cookie", async () => {
    const { trunk } = await buildStack({
      registerDocUnpublish: true,
    });
    const res = await trunk.request("/docs/unpublish/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("POST /docs/unpublish/:doc_id with a non-UUID param returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocUnpublish: true,
    });
    await signUp(trunk, "peter@example.com");
    const signInRes = await signIn(trunk, "peter@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/unpublish/not-a-uuid", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(400);

    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/unpublish/:doc_id 403s for a member role (no doc:publish scope)", async () => {
    // Same gate-fires-first shape as publish — the scope `doc:publish`
    // guards both directions, and `member` doesn't hold it. A single
    // deny-audit row lands via `withAuditTx`; no write-path tx opens,
    // so no `docs.visibility` bump is possible.
    const { trunk } = await buildStack({
      registerDocUnpublish: true,
    });
    await signUp(trunk, "quinn@example.com");
    const signInRes = await signIn(trunk, "quinn@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/unpublish/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(403);

    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.capability_id).toBe("doc.unpublish");
    expect(audits[0]?.outcome).toBe("deny");
  });

  it("POST /docs/unpublish/:doc_id for a doc in a different workspace denies before reaching the SELECT (scope gate fires first)", async () => {
    // Mirror of the publish cross-workspace test — two layers of
    // protection, but only the scope-gate layer is observable today
    // (every authenticated user is a member). When role widening lands,
    // a follow-up allow-path test will exercise the tenant-scoped
    // SELECT's 404 on cross-workspace targets.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocUnpublish: true,
      withSync: true,
    });
    await signUp(trunk, "rose@example.com");
    const roseSignIn = await signIn(trunk, "rose@example.com");
    const roseCookie = sessionCookieFrom(roseSignIn);
    await signUp(trunk, "sam@example.com");
    const samSignIn = await signIn(trunk, "sam@example.com");
    const samCookie = sessionCookieFrom(samSignIn);

    // Rose creates a doc.
    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie: roseCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Rose's doc" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    // Sam tries to unpublish it. Gate denies (member role).
    const res = await trunk.request(`/docs/unpublish/${doc_id}`, {
      method: "POST",
      headers: { cookie: samCookie },
    });
    expect(res.status).toBe(403);

    // Row unchanged — visibility still "workspace", visibility_version
    // still 0. Same brand-via-`DocId()` dance as the publish sibling.
    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["visibility", "visibility_version"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.visibility).toBe("workspace");
    expect(row.visibility_version).toBe(0);
  });
});
