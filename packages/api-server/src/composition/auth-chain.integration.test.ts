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
  docDelete,
  docGet,
  docList,
  docPublish,
  docRename,
  docRestore,
  docUnpublish,
  docUpdate,
  registerCapability,
} from "@editorzero/capabilities";
import {
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createLoadRoles,
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
    registerDocDelete?: boolean;
    registerDocRestore?: boolean;
    registerDocRename?: boolean;
    registerDocUpdate?: boolean;
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
    ...(options.registerDocDelete ? [registerCapability(docDelete)] : []),
    ...(options.registerDocRestore ? [registerCapability(docRestore)] : []),
    ...(options.registerDocRename ? [registerCapability(docRename)] : []),
    ...(options.registerDocUpdate ? [registerCapability(docUpdate)] : []),
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
  const loadRoles = createLoadRoles(driver);
  const trunk = createApiApp({ auth, loadRoles, dispatcher });
  return { auth, dispatcher, loadRoles, trunk };
}

async function signUp(
  trunk: Awaited<ReturnType<typeof buildStack>>["trunk"],
  email: string,
  opts: { readonly overrideRole?: "admin" | "member" | "guest" | "remove" } = {},
) {
  const res = await trunk.request("/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "correct-horse-battery-staple",
      name: email.split("@")[0],
    }),
  });
  // Post-ADR 0024 the `user.create.after` hook in
  // `@editorzero/auth`'s `createAuth` seeds a `workspace_members`
  // row as `role: "owner"` post-commit on signup (BA fires `after`
  // hooks via `queueAfterTransactionHook`; hook errors propagate as
  // signup failures — not atomic, but fail-loud). The user just
  // minted a fresh workspace and owns it by construction, so the
  // default signup path needs NO test-side seeding. `overrideRole`
  // exists only to exercise scenarios the hook can't produce on
  // its own: "admin" / "member" / "guest" for scope-gate tests
  // that assert a specific deny behaviour, and "remove" for the
  // strict-on-missing branch.
  if (res.status === 200 && opts.overrideRole !== undefined) {
    if (opts.overrideRole === "remove") {
      await removeMembership(email);
    } else {
      await overrideRole(email, opts.overrideRole);
    }
  }
  return res;
}

async function signIn(trunk: Awaited<ReturnType<typeof buildStack>>["trunk"], email: string) {
  return trunk.request("/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
}

/**
 * Look up the hook-seeded `workspace_members` row for `email` and
 * rewrite its `role` column to `role`. Used to construct a test
 * scenario the production bootstrap path can't: downgrade a user
 * from the auto-minted `"owner"` to `"member"` / `"admin"` / `"guest"`
 * so scope-gate deny assertions parameterize on the intended role
 * without re-implementing the whole bootstrap.
 */
async function overrideRole(email: string, role: "admin" | "member" | "guest"): Promise<void> {
  const user_id = await lookupUserIdByEmail(email);
  await driver
    .system()
    .updateTable("workspace_members")
    .set({ role, updated_at: Date.now() })
    .where("user_id", "=", user_id)
    .execute();
}

/**
 * Hard-delete the hook-seeded `workspace_members` row to exercise
 * the resolver's strict-on-missing branch (ADR 0024). Production
 * can't normally hit this branch: the bootstrap hook runs post-
 * commit on every signup and its errors propagate as signup
 * failures (fail-loud), so a signed-in user without an active
 * membership row is a rare structural scenario. In-test we
 * simulate the "row went missing" state (future partial-hook-
 * failure, ADR 0017 cascade, or migration gap).
 */
async function removeMembership(email: string): Promise<void> {
  const user_id = await lookupUserIdByEmail(email);
  await driver.system().deleteFrom("workspace_members").where("user_id", "=", user_id).execute();
}

async function lookupUserIdByEmail(email: string): Promise<UserId> {
  const row = await driver
    .system()
    // biome-ignore lint/suspicious/noExplicitAny: user table is Better Auth's, outside our Database type.
    .selectFrom("user" as any)
    .select(["id" as never])
    .where("email" as never, "=", email as never)
    .executeTakeFirstOrThrow();
  const typed = row as { id: string };
  return UserId(typed.id);
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
    const { auth, loadRoles, trunk } = await buildStack();
    await signUp(trunk, "bob@example.com");

    const signInRes = await signIn(trunk, "bob@example.com");
    expect(signInRes.status).toBe(200);

    const cookie = sessionCookieFrom(signInRes);
    expect(cookie).toContain("session_token");

    const resolver = createBetterAuthResolver({ auth, loadRoles });
    const principal = await resolver(new Headers({ cookie }));
    expect(principal).not.toBeNull();
    if (principal === null) throw new Error("unreachable");
    expect(principal.kind).toBe("user");
    expect(principal.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
  });

  it("principal + dispatcher middleware attach to c.var for an authenticated probe route", async () => {
    const { auth, dispatcher, loadRoles, trunk } = await buildStack();
    // Mount the probe BEFORE the first request — Hono's SmartRouter
    // lazily builds its match tree on first request, and once built it
    // refuses further `.use()` / `.get()` calls. Real capability routes
    // compose through `openapiRoutes([...] as const)` at factory time,
    // so they land before any request too. This test uses the same
    // mount-early discipline.
    const resolve = createBetterAuthResolver({ auth, loadRoles });
    trunk.use(
      "/probe",
      createPrincipalMiddleware({
        resolve: (c) => resolve(c.req.raw.headers),
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
    const { auth, dispatcher, loadRoles, trunk } = await buildStack();
    const resolve = createBetterAuthResolver({ auth, loadRoles });
    trunk.use(
      "/probe",
      createPrincipalMiddleware({
        resolve: (c) => resolve(c.req.raw.headers),
      }),
    );
    trunk.use("/probe", createDispatcherMiddleware({ dispatcher }));
    trunk.get("/probe", (c) => c.json({ ok: true }));

    const res = await trunk.request("/probe");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  // ── GET /infra/whoami — canonical principal-orientation route (ADR 0025) ─
  //
  // The CLI's `ez auth whoami` calls this route (not BA's
  // `/auth/get-session`) so the caller sees the same `Principal` shape
  // the dispatcher/gate enforces — `kind`, `workspace_id`, `roles`
  // sourced from `workspace_members` via the ADR 0024 resolver. These
  // tests exercise the full chain (BA session → principal middleware →
  // whoami handler) against a real in-memory DB.
  it("GET /infra/whoami 401s without a session cookie", async () => {
    const { trunk } = await buildStack();
    const res = await trunk.request("/infra/whoami");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  it("GET /infra/whoami returns the caller's Principal for an authenticated owner", async () => {
    // Fresh signup mints a workspace + seeds `workspace_members` as
    // `role: "owner"` via the ADR 0024 post-commit hook. Whoami should
    // reflect that same owner role, the same workspace_id, and the
    // session-backed credential shape (session_id non-null, token_id
    // null — this is a cookie-authenticated session, not a bearer).
    const { trunk } = await buildStack();
    await signUp(trunk, "whoami-owner@example.com");
    const signInRes = await signIn(trunk, "whoami-owner@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/infra/whoami", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: "user";
      id: string;
      workspace_id: string;
      roles: readonly string[];
      session_id: string | null;
      token_id: string | null;
    };
    expect(body.kind).toBe("user");
    expect(body.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
    expect(body.roles).toEqual(["owner"]);
    expect(body.session_id).not.toBeNull();
    expect(body.token_id).toBeNull();
  });

  it("GET /infra/whoami reflects a role downgrade (loadRoles is the single source of role truth)", async () => {
    // Override the hook-seeded "owner" to "member" and re-sign-in; the
    // whoami projection must report "member" on the next call. This
    // guards the invariant that the whoami route reads through the
    // same `loadRoles` path the dispatcher/gate uses — not a cached
    // or stale view.
    const { trunk } = await buildStack();
    await signUp(trunk, "whoami-member@example.com", { overrideRole: "member" });
    const signInRes = await signIn(trunk, "whoami-member@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/infra/whoami", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: readonly string[] };
    expect(body.roles).toEqual(["member"]);
  });

  it("GET /infra/health stays public even after /infra/whoami is gated (regression check)", async () => {
    // Adding principal middleware to `/infra/whoami` must not leak to
    // `/infra/health` — the two routes share a prefix but differ in
    // auth posture (ADR 0025 + the comment on `createApiApp`).
    const { trunk } = await buildStack();
    const res = await trunk.request("/infra/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("GET /docs/list round-trips through the full stack (auth → principal mw → dispatcher → doc.list capability)", async () => {
    const { auth, loadRoles, trunk } = await buildStack({ registerDocList: true });
    await signUp(trunk, "dana@example.com");
    const signInRes = await signIn(trunk, "dana@example.com");
    const cookie = sessionCookieFrom(signInRes);

    // Resolve the principal once to discover the minted workspace_id
    // so we can seed a docs row inside that tenant.
    const principal = await createBetterAuthResolver({ auth, loadRoles })(new Headers({ cookie }));
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
    const { auth, loadRoles, trunk } = await buildStack({ registerDocList: true });
    await signUp(trunk, "dana@example.com");
    await signUp(trunk, "eve@example.com");
    const danaSignIn = await signIn(trunk, "dana@example.com");
    const danaCookie = sessionCookieFrom(danaSignIn);
    const eveSignIn = await signIn(trunk, "eve@example.com");
    const eveCookie = sessionCookieFrom(eveSignIn);

    const resolver = createBetterAuthResolver({ auth, loadRoles });
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
  // Post-ADR 0024 the resolver sources role from `workspace_members`,
  // populated by the `user.create.after` bootstrap hook in
  // `@editorzero/auth` as `role: "owner"` on every fresh signup. The
  // default `signUp(...)` call therefore produces an owner principal
  // (has `doc:publish`), so the allow test below needs no explicit
  // override. Deny tests use `{ overrideRole: "member" }` to downgrade
  // the hook-seeded row and parameterize on the missing scope.
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
    await signUp(trunk, "mia@example.com", { overrideRole: "member" });
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
    // (a) the dispatcher's scope gate (the signing-in member principal
    // lacks `doc:publish`, so the deny fires here before the handler),
    // and (b) the tenant-scoped `ctx.db` with `WorkspaceScopingPlugin`
    // (if the gate ever allowed the handler to run, the SELECT-on-UPDATE
    // would return 0 rows for cross-workspace targets → 404). This test
    // parameterizes on the default `"member"` seed so (a) is the
    // observable branch; the (b) layer is exercised by the happy-path
    // allow test above (owner seed) plus the doc.list tenant-isolation
    // test — both pin the same scoping-plugin predicate.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocPublish: true,
      withSync: true,
    });
    await signUp(trunk, "nora@example.com", { overrideRole: "member" });
    const noraSignIn = await signIn(trunk, "nora@example.com");
    const noraCookie = sessionCookieFrom(noraSignIn);
    await signUp(trunk, "oscar@example.com", { overrideRole: "member" });
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

  it("POST /docs/publish/:doc_id flips visibility to public for an owner principal", async () => {
    // Happy-path allow — post-ADR 0024 the resolver reads role from
    // `workspace_members`, so seeding `"owner"` lets the caller clear
    // the scope gate. The route response carries the post-state
    // projection; the durable row flips to `visibility="public"` with
    // `visibility_version` bumped from 0 → 1 in the same write-path tx
    // that wrote the allow-audit row. No `doc_updates` row lands —
    // publish is metadata-only, never touches `ctx.transact`.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocPublish: true,
      withSync: true,
    });
    await signUp(trunk, "paula@example.com");
    const signInRes = await signIn(trunk, "paula@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Paula's doc" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    const res = await trunk.request(`/docs/publish/${doc_id}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      doc_id: string;
      visibility: "public";
      visibility_version: number;
      published_at: number;
    };
    expect(body.doc_id).toBe(doc_id);
    expect(body.visibility).toBe("public");
    expect(body.visibility_version).toBe(1);
    expect(body.published_at).toBeGreaterThan(0);

    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["visibility", "visibility_version"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.visibility).toBe("public");
    expect(row.visibility_version).toBe(1);

    // Audit trail: create (allow) + publish (allow). Two rows total; no
    // deny, no `doc_updates` row from publish (metadata-only).
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .orderBy("created_at")
      .execute();
    expect(audits.map((a) => ({ id: a.capability_id, o: a.outcome }))).toEqual([
      { id: "doc.create", o: "allow" },
      { id: "doc.publish", o: "allow" },
    ]);
  });

  // ── POST /docs/unpublish/:doc_id — inverse of publish ────────────────
  //
  // Same authz envelope as publish (scope `doc:publish`, owners/admins
  // hold it, members don't). Default `signUp(...)` produces the auto-
  // minted owner principal (hook-seeded); deny tests use
  // `{ overrideRole: "member" }`. Allow test below publishes then
  // unpublishes to exercise the return-to-workspace transition end-
  // to-end.
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
    await signUp(trunk, "quinn@example.com", { overrideRole: "member" });
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
    // protection, but the scope-gate layer is what this test pins
    // (member seed lacks `doc:publish`, so the deny fires here). The
    // happy-path allow test above + the doc.list tenant-isolation test
    // cover the scoping-plugin layer under an owner principal.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocUnpublish: true,
      withSync: true,
    });
    await signUp(trunk, "rose@example.com", { overrideRole: "member" });
    const roseSignIn = await signIn(trunk, "rose@example.com");
    const roseCookie = sessionCookieFrom(roseSignIn);
    await signUp(trunk, "sam@example.com", { overrideRole: "member" });
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

  it("POST /docs/unpublish/:doc_id flips a published doc back to workspace for an owner principal", async () => {
    // Happy-path allow. The flow is: create (workspace, v0) → publish
    // (public, v1) → unpublish (workspace, v2). Each allow audit row
    // lands in order; no deny, no `doc_updates` rows from publish /
    // unpublish (both metadata-only).
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocPublish: true,
      registerDocUnpublish: true,
      withSync: true,
    });
    await signUp(trunk, "rachel@example.com");
    const signInRes = await signIn(trunk, "rachel@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Rachel's doc" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    const publishRes = await trunk.request(`/docs/publish/${doc_id}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(publishRes.status).toBe(200);

    const res = await trunk.request(`/docs/unpublish/${doc_id}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      doc_id: string;
      visibility: "workspace";
      visibility_version: number;
    };
    expect(body.doc_id).toBe(doc_id);
    expect(body.visibility).toBe("workspace");
    expect(body.visibility_version).toBe(2);

    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["visibility", "visibility_version"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.visibility).toBe("workspace");
    expect(row.visibility_version).toBe(2);

    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .orderBy("created_at")
      .execute();
    expect(audits.map((a) => ({ id: a.capability_id, o: a.outcome }))).toEqual([
      { id: "doc.create", o: "allow" },
      { id: "doc.publish", o: "allow" },
      { id: "doc.unpublish", o: "allow" },
    ]);
  });

  // ── POST /docs/delete/:doc_id — soft-delete (ADR 0017, invariant 6) ──
  //
  // Scope is `doc:delete`, not `doc:publish` — distinct authz envelope
  // from publish/unpublish but same "member lacks it" fact pattern.
  // Deny tests downgrade the hook-seeded owner to `"member"`; the allow
  // test uses the default owner to exercise the soft-delete transition
  // end-to-end.
  it("POST /docs/delete/:doc_id 401s without a session cookie", async () => {
    const { trunk } = await buildStack({
      registerDocDelete: true,
    });
    const res = await trunk.request("/docs/delete/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("POST /docs/delete/:doc_id with a non-UUID param returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocDelete: true,
    });
    await signUp(trunk, "tina@example.com");
    const signInRes = await signIn(trunk, "tina@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/delete/not-a-uuid", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(400);

    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/delete/:doc_id 403s for a member role (no doc:delete scope)", async () => {
    // Same gate-fires-first pattern as publish/unpublish. `doc:delete`
    // is an `editor`-tier scope (AGENT_SCOPE_TIERS); a `member` doesn't
    // hold it, so the PermissionGate denies before the handler runs
    // and one deny-audit row lands via `withAuditTx`.
    const { trunk } = await buildStack({
      registerDocDelete: true,
    });
    await signUp(trunk, "uma@example.com", { overrideRole: "member" });
    const signInRes = await signIn(trunk, "uma@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/delete/018f0000-0000-7000-8000-0000000000a1", {
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
    expect(audits[0]?.capability_id).toBe("doc.delete");
    expect(audits[0]?.outcome).toBe("deny");
  });

  it("POST /docs/delete/:doc_id for a doc in a different workspace denies before reaching the SELECT (scope gate fires first)", async () => {
    // Mirror of publish's cross-workspace test. The `doc:delete`
    // gate fires before the handler; tenant-scoped SELECT would be
    // the second guard on the allow path (observable after role
    // widening lands).
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocDelete: true,
      withSync: true,
    });
    await signUp(trunk, "vera@example.com", { overrideRole: "member" });
    const veraSignIn = await signIn(trunk, "vera@example.com");
    const veraCookie = sessionCookieFrom(veraSignIn);
    await signUp(trunk, "walt@example.com", { overrideRole: "member" });
    const waltSignIn = await signIn(trunk, "walt@example.com");
    const waltCookie = sessionCookieFrom(waltSignIn);

    // Vera creates a doc.
    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie: veraCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Vera's doc" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    // Walt tries to delete it. Gate denies (member role).
    const res = await trunk.request(`/docs/delete/${doc_id}`, {
      method: "POST",
      headers: { cookie: waltCookie },
    });
    expect(res.status).toBe(403);

    // Row unchanged — deleted_at still null, version still 0.
    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.visibility_version).toBe(0);
  });

  it("POST /docs/delete/:doc_id soft-deletes a doc for an owner principal", async () => {
    // Happy-path allow. Create (live) → delete (soft-deleted, version
    // bumped, `deleted_at` populated with a non-null epoch). Two allow
    // audit rows land in order; no `doc_updates` rows from delete
    // (metadata-only — the soft-delete is a row UPDATE, not a Y.Doc
    // mutation).
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocDelete: true,
      withSync: true,
    });
    await signUp(trunk, "tara@example.com");
    const signInRes = await signIn(trunk, "tara@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Tara's doc" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    const res = await trunk.request(`/docs/delete/${doc_id}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      doc_id: string;
      deleted_at: number;
      visibility_version: number;
    };
    expect(body.doc_id).toBe(doc_id);
    expect(body.deleted_at).toBeGreaterThan(0);
    expect(body.visibility_version).toBe(1);

    // Durable row soft-deleted; the tenant-scoped `docs` view filter
    // hides it from subsequent reads, but the raw system row still
    // carries `deleted_at`.
    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBe(body.deleted_at);
    expect(row.visibility_version).toBe(1);

    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .orderBy("created_at")
      .execute();
    expect(audits.map((a) => ({ id: a.capability_id, o: a.outcome }))).toEqual([
      { id: "doc.create", o: "allow" },
      { id: "doc.delete", o: "allow" },
    ]);
  });

  // ── POST /docs/restore/:doc_id — revive (ADR 0017, invariant 6) ──────
  //
  // Same authz envelope as delete (scope `doc:delete`), same member-
  // lacks-it observable pattern for the deny branch. Allow branch uses
  // the default owner; the happy-path test creates → deletes → restores
  // to exercise revive semantics end-to-end.
  it("POST /docs/restore/:doc_id 401s without a session cookie", async () => {
    const { trunk } = await buildStack({
      registerDocRestore: true,
    });
    const res = await trunk.request("/docs/restore/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("POST /docs/restore/:doc_id with a non-UUID param returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocRestore: true,
    });
    await signUp(trunk, "xena@example.com");
    const signInRes = await signIn(trunk, "xena@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/restore/not-a-uuid", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(400);

    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/restore/:doc_id 403s for a member role (no doc:delete scope)", async () => {
    const { trunk } = await buildStack({
      registerDocRestore: true,
    });
    await signUp(trunk, "yuri@example.com", { overrideRole: "member" });
    const signInRes = await signIn(trunk, "yuri@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/restore/018f0000-0000-7000-8000-0000000000a1", {
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
    expect(audits[0]?.capability_id).toBe("doc.restore");
    expect(audits[0]?.outcome).toBe("deny");
  });

  it("POST /docs/restore/:doc_id for a doc in a different workspace denies before reaching the SELECT (scope gate fires first)", async () => {
    // Cross-workspace restore; same posture as the delete sibling.
    // The doc is seeded as soft-deleted under Zara's workspace to
    // exercise restore's semantics; Aaron's member-role deny fires
    // before the SELECT runs regardless.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocDelete: true,
      registerDocRestore: true,
      withSync: true,
    });
    await signUp(trunk, "zara@example.com", { overrideRole: "member" });
    const zaraSignIn = await signIn(trunk, "zara@example.com");
    const zaraCookie = sessionCookieFrom(zaraSignIn);
    await signUp(trunk, "aaron@example.com", { overrideRole: "member" });
    const aaronSignIn = await signIn(trunk, "aaron@example.com");
    const aaronCookie = sessionCookieFrom(aaronSignIn);

    // Zara creates a doc — we can't actually delete it via the API
    // (member lacks doc:delete), so seed the soft-delete directly via
    // the driver to set up the restore target state.
    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie: zaraCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Zara's doc" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    await driver.withSystemTx(async (tx) => {
      await tx
        .updateTable("docs")
        .set({ deleted_at: 1_000_000 })
        .where("id", "=", DocId(doc_id))
        .execute();
    });

    // Aaron tries to restore it. Gate denies (member role).
    const res = await trunk.request(`/docs/restore/${doc_id}`, {
      method: "POST",
      headers: { cookie: aaronCookie },
    });
    expect(res.status).toBe(403);

    // Row unchanged — deleted_at still set, version not bumped.
    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBe(1_000_000);
    expect(row.visibility_version).toBe(0);
  });

  it("POST /docs/restore/:doc_id revives a soft-deleted doc for an owner principal", async () => {
    // Happy-path allow. Create → delete → restore; the `deleted_at`
    // column returns to NULL on the durable row and `visibility_version`
    // bumps to 2 (one bump per metadata mutation). Three allow audits
    // land in order; no `doc_updates` rows from delete or restore
    // (both metadata-only).
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocDelete: true,
      registerDocRestore: true,
      withSync: true,
    });
    await signUp(trunk, "uma2@example.com");
    const signInRes = await signIn(trunk, "uma2@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Uma's doc" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    const deleteRes = await trunk.request(`/docs/delete/${doc_id}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(deleteRes.status).toBe(200);

    const res = await trunk.request(`/docs/restore/${doc_id}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      doc_id: string;
      visibility_version: number;
    };
    expect(body.doc_id).toBe(doc_id);
    expect(body.visibility_version).toBe(2);

    // Durable row restored — deleted_at back to null, version bumped.
    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.visibility_version).toBe(2);

    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .orderBy("created_at")
      .execute();
    expect(audits.map((a) => ({ id: a.capability_id, o: a.outcome }))).toEqual([
      { id: "doc.create", o: "allow" },
      { id: "doc.delete", o: "allow" },
      { id: "doc.restore", o: "allow" },
    ]);
  });

  // ── POST /docs/rename/:doc_id — first content-mutation after create ──
  //
  // Scope is `doc:write` (members, admins, owners hold it; guests do
  // not). Same content-mutation lane as `doc.create` — the handler
  // dual-writes `docs.title` + the Y.Doc title block in the same
  // write-path tx, so `withSync: true` is required.

  it("POST /docs/rename/:doc_id 401s without a session cookie", async () => {
    const { trunk } = await buildStack({
      registerDocRename: true,
      withSync: true,
    });
    const res = await trunk.request("/docs/rename/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /docs/rename/:doc_id with a non-UUID param returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocRename: true,
      withSync: true,
    });
    await signUp(trunk, "pam@example.com");
    const signInRes = await signIn(trunk, "pam@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/rename/not-a-uuid", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(400);

    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/rename/:doc_id with an empty title returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocRename: true,
      withSync: true,
    });
    await signUp(trunk, "quinn@example.com");
    const signInRes = await signIn(trunk, "quinn@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/rename/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);

    // Route-level zod body validation rejected before the dispatcher
    // — no audit row.
    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/rename/:doc_id 403s for a guest role (no doc:write scope)", async () => {
    // Guests have `doc:read` + `comment:*` but NOT `doc:write` per
    // `ROLE_SCOPES` in `packages/dispatcher/src/gate.ts`. Members /
    // admins / owners hold `doc:write` (that's the create/rename/
    // update lane), so `guest` is the only workspace-role tier that
    // denies. Deny audit row lands + nothing else runs.
    const { trunk } = await buildStack({
      registerDocRename: true,
      withSync: true,
    });
    await signUp(trunk, "rick@example.com", { overrideRole: "guest" });
    const signInRes = await signIn(trunk, "rick@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/rename/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(403);

    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.capability_id).toBe("doc.rename");
    expect(audits[0]?.outcome).toBe("deny");
  });

  it("POST /docs/rename/:doc_id renames a doc for an owner principal (title + slug + updated_at)", async () => {
    // End-to-end happy path: create → rename → get. Verifies the
    // dual-write bridge (docs.title row update + Y.Doc title block
    // mutation via ctx.transact) lands atomically in the write-path
    // tx, and that both `doc.get` (reads docs.title directly) and
    // the hydrated block tree reflect the new title.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocGet: true,
      registerDocRename: true,
      withSync: true,
    });
    await signUp(trunk, "susan@example.com");
    const signInRes = await signIn(trunk, "susan@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Old Title" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id } = (await createRes.json()) as { doc_id: string };

    const renameRes = await trunk.request(`/docs/rename/${doc_id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "New Title" }),
    });
    expect(renameRes.status).toBe(200);
    const renameBody = (await renameRes.json()) as {
      doc_id: string;
      title: string;
      slug: string;
      updated_at: number;
    };
    expect(renameBody.doc_id).toBe(doc_id);
    expect(renameBody.title).toBe("New Title");
    expect(renameBody.slug).toBe("new-title");
    expect(renameBody.updated_at).toBeGreaterThan(0);

    // Durable row-side: docs.title + slug + updated_at updated.
    const row = await driver
      .system()
      .selectFrom("docs")
      .select(["title", "slug", "updated_at"])
      .where("id", "=", DocId(doc_id))
      .executeTakeFirstOrThrow();
    expect(row.title).toBe("New Title");
    expect(row.slug).toBe("new-title");
    expect(row.updated_at).toBe(renameBody.updated_at);

    // Durable block-side: `GET /docs/get/:doc_id` hydrates from
    // `doc_updates` (onLoadDocument → readByDocUntransacted → apply)
    // and projects the blocks. The heading-1 title block reflects
    // the rename. Two doc_updates rows — seed (from create) + rename
    // (from ctx.transact).
    const updates = await driver
      .system()
      .selectFrom("doc_updates")
      .select(["seq"])
      .where("doc_id", "=", DocId(doc_id))
      .orderBy("seq", "asc")
      .execute();
    expect(updates.map((u) => u.seq)).toEqual([1, 2]);

    const getRes = await trunk.request(`/docs/get/${doc_id}`, { headers: { cookie } });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      doc: { id: string; title: string };
      blocks: ReadonlyArray<{ type: string; content?: unknown }>;
    };
    expect(getBody.doc.title).toBe("New Title");
    // First block is the heading-1 carrying the new title; second
    // is the paragraph seed.
    expect(getBody.blocks[0]?.type).toBe("heading");

    // Audit trail: create + rename + get, all allows.
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .orderBy("created_at")
      .execute();
    expect(audits.map((a) => ({ id: a.capability_id, o: a.outcome }))).toEqual([
      { id: "doc.create", o: "allow" },
      { id: "doc.rename", o: "allow" },
      { id: "doc.get", o: "allow" },
    ]);
  });

  it("POST /docs/rename/:doc_id 404s a missing doc (rename is live-doc only)", async () => {
    const { trunk } = await buildStack({
      registerDocRename: true,
      withSync: true,
    });
    await signUp(trunk, "tara@example.com");
    const signInRes = await signIn(trunk, "tara@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const missing = "018f0000-0000-7000-8000-0000000000e9";
    const res = await trunk.request(`/docs/rename/${missing}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Attempt" }),
    });
    expect(res.status).toBe(404);

    // Dispatcher ran (scope check passed, handler threw
    // NotFoundError post-UPDATE). Error-class audit row lands —
    // this is the dispatcher's `effectOnError` projection.
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.capability_id).toBe("doc.rename");
    expect(audits[0]?.outcome).toBe("error");
  });
});

describe("POST /docs/update/:doc_id — full stack", () => {
  // `doc.update` is F12 canonical batched content-mutation. Same lane
  // as `doc.create` and `doc.rename`: dispatcher runs the handler inside
  // a write-path tx, handler opens `ctx.transact` → `withLiveEditor` →
  // `editor.transact` to apply all ops as one y-prosemirror step.
  // Scopes: `doc:write` + `block:write` (both held by member / admin /
  // owner; guest holds neither).

  it("POST /docs/update/:doc_id 401s without a session cookie", async () => {
    const { trunk } = await buildStack({
      registerDocUpdate: true,
      withSync: true,
    });
    const res = await trunk.request("/docs/update/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "update",
            block_id: "018f0000-0000-7000-8000-00000000b001",
            patch: { content: "x" },
          },
        ],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /docs/update/:doc_id with a non-UUID param returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocUpdate: true,
      withSync: true,
    });
    await signUp(trunk, "ursula@example.com");
    const signInRes = await signIn(trunk, "ursula@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/update/not-a-uuid", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "update",
            block_id: "018f0000-0000-7000-8000-00000000b001",
            patch: { content: "x" },
          },
        ],
      }),
    });
    expect(res.status).toBe(400);

    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/update/:doc_id with an empty ops array returns 400 before the dispatcher runs", async () => {
    const { trunk } = await buildStack({
      registerDocUpdate: true,
      withSync: true,
    });
    await signUp(trunk, "vera@example.com");
    const signInRes = await signIn(trunk, "vera@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/update/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ops: [] }),
    });
    expect(res.status).toBe(400);

    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(0);
  });

  it("POST /docs/update/:doc_id 403s for a guest role (no doc:write / block:write)", async () => {
    // Guests hold only `doc:read` + `block:read` + `comment:*` +
    // `workspace:read` per `ROLE_SCOPES`. `doc.update` requires
    // `doc:write` + `block:write`; guest lacks both — the gate denies
    // on the first missing scope.
    const { trunk } = await buildStack({
      registerDocUpdate: true,
      withSync: true,
    });
    await signUp(trunk, "walt@example.com", { overrideRole: "guest" });
    const signInRes = await signIn(trunk, "walt@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const res = await trunk.request("/docs/update/018f0000-0000-7000-8000-0000000000a1", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "update",
            block_id: "018f0000-0000-7000-8000-00000000b001",
            patch: { content: "x" },
          },
        ],
      }),
    });
    expect(res.status).toBe(403);

    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.capability_id).toBe("doc.update");
    expect(audits[0]?.outcome).toBe("deny");
  });

  it("create → update (append paragraph) → get reflects the inserted block end-to-end", async () => {
    // Full-stack happy path: owner creates a doc (seeded with
    // heading-1 + paragraph), then issues an `insert` op appending a
    // paragraph after the seed paragraph. `GET /docs/get/:doc_id`
    // hydrates from `doc_updates` (onLoadDocument → apply) and
    // projects the inserted block.
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocGet: true,
      registerDocUpdate: true,
      withSync: true,
    });
    await signUp(trunk, "xander@example.com");
    const signInRes = await signIn(trunk, "xander@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Empty" }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      doc_id: string;
      seed_blocks: ReadonlyArray<{ id: string; type: string }>;
    };
    const doc_id = createBody.doc_id;
    const paragraphSeedId = createBody.seed_blocks[1]?.id;
    expect(paragraphSeedId).toBeDefined();

    const updateRes = await trunk.request(`/docs/update/${doc_id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "insert",
            block: { type: "paragraph", content: "Appended by doc.update" },
            after_block_id: paragraphSeedId,
          },
        ],
      }),
    });
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      doc_id: string;
      applied_ops: ReadonlyArray<{
        op: string;
        block?: { id: string; type: string };
      }>;
      updated_at: number;
    };
    expect(updateBody.doc_id).toBe(doc_id);
    expect(updateBody.applied_ops).toHaveLength(1);
    expect(updateBody.applied_ops[0]?.op).toBe("insert");
    const insertedId = updateBody.applied_ops[0]?.block?.id;
    expect(insertedId).toBeDefined();

    // Two doc_updates rows: seed (doc.create) + insert (doc.update).
    const updates = await driver
      .system()
      .selectFrom("doc_updates")
      .select(["seq"])
      .where("doc_id", "=", DocId(doc_id))
      .orderBy("seq", "asc")
      .execute();
    expect(updates.map((u) => u.seq)).toEqual([1, 2]);

    // `GET /docs/get/:doc_id` hydrates from doc_updates and projects
    // the inserted block. `withLiveEditor` mount adds BlockNote's
    // normalisation-tail paragraph, so post-insert block list is:
    // [heading-1 title, paragraph-seed, paragraph-inserted, trailing-
    // paragraph-from-mount]. Test asserts the inserted id is present
    // and the count is 4 — the mount tail is stable BlockNote
    // behaviour, not noise.
    const getRes = await trunk.request(`/docs/get/${doc_id}`, { headers: { cookie } });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      blocks: ReadonlyArray<{ id: string; type: string; content?: unknown }>;
    };
    expect(getBody.blocks).toHaveLength(4);
    const insertedIdx = getBody.blocks.findIndex((b) => b.id === insertedId);
    expect(insertedIdx).toBeGreaterThanOrEqual(0);
    expect(getBody.blocks[insertedIdx]?.type).toBe("paragraph");

    // Audit trail: create + update + get, all allows.
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .orderBy("created_at")
      .execute();
    expect(audits.map((a) => ({ id: a.capability_id, o: a.outcome }))).toEqual([
      { id: "doc.create", o: "allow" },
      { id: "doc.update", o: "allow" },
      { id: "doc.get", o: "allow" },
    ]);
  });

  it("POST /docs/update/:doc_id 404s a missing doc", async () => {
    const { trunk } = await buildStack({
      registerDocUpdate: true,
      withSync: true,
    });
    await signUp(trunk, "yasmin@example.com");
    const signInRes = await signIn(trunk, "yasmin@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const missing = "018f0000-0000-7000-8000-0000000000e9";
    const res = await trunk.request(`/docs/update/${missing}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "update",
            block_id: "018f0000-0000-7000-8000-00000000b001",
            patch: { content: "x" },
          },
        ],
      }),
    });
    expect(res.status).toBe(404);

    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.capability_id).toBe("doc.update");
    expect(audits[0]?.outcome).toBe("error");
  });

  it("update op with a stale expect_prior_content_hash → 409 + error audit", async () => {
    // Full-stack StalePreconditionError path: create a doc, then issue
    // an update op with a deliberately wrong hash. The handler reads
    // the current block inside `withLiveEditor`, compares the hash,
    // throws StalePreconditionError (maps to 409). No block mutation
    // lands (the write-path tx rolls back on throw; doc_updates still
    // has only the seed row).
    const { trunk } = await buildStack({
      registerDocCreate: true,
      registerDocUpdate: true,
      withSync: true,
    });
    await signUp(trunk, "zara@example.com");
    const signInRes = await signIn(trunk, "zara@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const createRes = await trunk.request("/docs/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Precondition" }),
    });
    expect(createRes.status).toBe(201);
    const { doc_id, seed_blocks } = (await createRes.json()) as {
      doc_id: string;
      seed_blocks: ReadonlyArray<{ id: string }>;
    };
    const titleBlockId = seed_blocks[0]?.id;
    expect(titleBlockId).toBeDefined();

    const staleHash = "0".repeat(64);
    const res = await trunk.request(`/docs/update/${doc_id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "update",
            block_id: titleBlockId,
            patch: { content: "Shouldn't land" },
            expect_prior_content_hash: staleHash,
          },
        ],
      }),
    });
    expect(res.status).toBe(409);
    // Body shape: `{ error: "stale_precondition" }`. The global error
    // mapper (`createApiApp.trunk.onError`) returns `{ error: err.code }`
    // and `StalePreconditionError.code = "stale_precondition"` (not
    // `"conflict"` — that's `ConflictError`'s code, for dispatcher
    // seq-retry exhaustion). Pinning the wire shape here keeps the
    // route's 409 response schema honest against runtime behaviour.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("stale_precondition");

    // doc_updates still only has the seed row — the mutation rolled
    // back atomically.
    const updates = await driver
      .system()
      .selectFrom("doc_updates")
      .select(["seq"])
      .where("doc_id", "=", DocId(doc_id))
      .orderBy("seq", "asc")
      .execute();
    expect(updates.map((u) => u.seq)).toEqual([1]);

    // Error-class audit row for the stale update.
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome"])
      .orderBy("created_at")
      .execute();
    expect(audits.map((a) => ({ id: a.capability_id, o: a.outcome }))).toEqual([
      { id: "doc.create", o: "allow" },
      { id: "doc.update", o: "error" },
    ]);
  });
});
