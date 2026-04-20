/**
 * `ez auth` end-to-end smoke (ADR 0025).
 *
 * Builds the real trunk in-process — `createApiApp({ auth, loadRoles,
 * dispatcher })` against a `:memory:` SQLite — and drives `runLogin`,
 * `runWhoami`, `runLogout` against it via an in-memory credential
 * store + `trunk.request` bound as `typeof fetch`. Exercises the full
 * chain the unit tests can't: Better Auth `/auth/sign-in/email`
 * returning a real `Set-Cookie`, principal middleware materialising
 * the Principal from that cookie, the `/infra/whoami` handler reading
 * `c.var.principal` through the same resolver the dispatcher uses,
 * and `/auth/sign-out` invalidating the session.
 *
 * One scenario — login → whoami → logout → whoami. The final whoami
 * fails fast on the cleared local credential (no round-trip), which
 * is the commitment in ADR 0025 §5 and what every downstream agent
 * harness will observe.
 *
 * No `HocuspocusSync` wired — this slice exercises auth-only paths
 * (`/auth/*` + `/infra/whoami`); content-mutation capabilities are
 * out of scope. The dispatcher still gets constructed because
 * `createApiApp` branches on its absence (no `/docs/*` middleware
 * without it) and we want the production composition shape.
 */

import { PassThrough } from "node:stream";

import { createApiApp } from "@editorzero/api-server";
import { createAuth, runAuthMigrations } from "@editorzero/auth";
import {
  createLoadRoles,
  createSqliteDriver,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthCredentialStore, CredentialHeaders } from "../credential-store";
import { runLogin } from "./login";
import { runLogout } from "./logout";
import { runWhoami } from "./whoami";

const BASE_URL = "http://localhost:3000";

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

async function buildTrunk() {
  // No dispatcher wired — this slice exercises only `/auth/*` +
  // `/infra/whoami`, neither of which reads `c.var.dispatcher`. The
  // production composition root adds one; tests that drive
  // `/docs/*` (in `packages/api-server/src/composition/auth-chain.
  // integration.test.ts`) construct one via `createApiDispatcher`.
  const auth = createAuth({
    driver,
    baseURL: BASE_URL,
    secret: "test-secret-do-not-use-in-production-at-all",
    trustedOrigins: [BASE_URL],
  });
  await runAuthMigrations(auth);
  const loadRoles = createLoadRoles(driver);
  return createApiApp({ auth, loadRoles });
}

function makeStoreFake(): AuthCredentialStore & {
  reads: number;
  writes: CredentialHeaders[];
  clears: number;
} {
  let current: CredentialHeaders | null = null;
  let reads = 0;
  const writes: CredentialHeaders[] = [];
  let clears = 0;
  return {
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    get clears() {
      return clears;
    },
    async read() {
      reads += 1;
      return current;
    },
    async write(headers) {
      current = headers;
      writes.push(headers);
    },
    async clear() {
      current = null;
      clears += 1;
    },
  };
}

function captured(): { stream: PassThrough; read: () => string; reset: () => void } {
  let chunks: Buffer[] = [];
  const stream = new PassThrough();
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    read: () => Buffer.concat(chunks).toString("utf8"),
    reset: () => {
      chunks = [];
    },
  };
}

async function signUp(
  trunk: Awaited<ReturnType<typeof buildTrunk>>,
  email: string,
  password: string,
): Promise<void> {
  const res = await trunk.request("/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: email.split("@")[0] }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-up failed with status ${res.status}`);
  }
}

describe("ez auth end-to-end (runLogin → runWhoami → runLogout)", () => {
  it("round-trips login → whoami → logout against the real trunk", async () => {
    const trunk = await buildTrunk();
    const email = "cli-e2e@example.com";
    const password = "correct-horse-battery-staple";
    await signUp(trunk, email, password);

    // Bind the trunk's in-process request as the injected `fetch`.
    // Hono's `request` accepts a full URL string and extracts the
    // pathname — the typed `hc<AppType>` client calls with e.g.
    // `http://localhost:3000/infra/whoami`, which routes through the
    // trunk identically to a real HTTP request.
    const fetch: typeof globalThis.fetch = async (input, init) =>
      trunk.request(typeof input === "string" || input instanceof URL ? input : input.url, init);
    const store = makeStoreFake();
    const out = captured();

    // 1. login — persists the session cookie + emits {ok, email}.
    const loginExit = await runLogin(
      { baseUrl: BASE_URL, email, password },
      { store, fetch, stdout: out.stream },
    );
    expect(loginExit).toBe(0);
    expect(store.writes).toHaveLength(1);
    // biome-ignore lint/complexity/useLiteralKeys: TS4111 — CredentialHeaders is a Record<string, string> index signature, bracket access required.
    expect(store.writes[0]?.["cookie"]).toContain("session_token");
    expect(JSON.parse(out.read())).toEqual({ ok: true, email });

    // 2. whoami — resolves the stored cookie to a Principal via
    //    /infra/whoami through the real middleware chain.
    out.reset();
    const whoamiExit = await runWhoami({ baseUrl: BASE_URL }, { store, fetch, stdout: out.stream });
    expect(whoamiExit).toBe(0);
    const whoamiBody = JSON.parse(out.read()) as {
      kind: string;
      id: string;
      workspace_id: string;
      roles: readonly string[];
      session_id: string | null;
      token_id: string | null;
    };
    expect(whoamiBody.kind).toBe("user");
    expect(whoamiBody.roles).toEqual(["owner"]);
    expect(whoamiBody.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
    expect(whoamiBody.session_id).not.toBeNull();
    expect(whoamiBody.token_id).toBeNull();

    // 3. logout — clears locally + invalidates server-side.
    out.reset();
    const logoutExit = await runLogout({ baseUrl: BASE_URL }, { store, fetch, stdout: out.stream });
    expect(logoutExit).toBe(0);
    expect(store.clears).toBe(1);
    expect(JSON.parse(out.read())).toEqual({ ok: true, server_cleared: true });

    // 4. whoami after logout — no local credential → auth_expired
    //    without a network call (fast-fail commitment).
    out.reset();
    const postExit = await runWhoami({ baseUrl: BASE_URL }, { store, fetch, stdout: out.stream });
    expect(postExit).toBe(1);
    const postBody = JSON.parse(out.read()) as { error: { code: string } };
    expect(postBody.error.code).toBe("auth_expired");
  });

  it("login against wrong password surfaces auth_failed + leaves store empty", async () => {
    const trunk = await buildTrunk();
    const email = "cli-e2e-bad@example.com";
    await signUp(trunk, email, "correct-horse-battery-staple");

    const fetch: typeof globalThis.fetch = async (input, init) =>
      trunk.request(typeof input === "string" || input instanceof URL ? input : input.url, init);
    const store = makeStoreFake();
    const { stream, read } = captured();

    const exit = await runLogin(
      { baseUrl: BASE_URL, email, password: "wrong-password" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    expect(store.writes).toHaveLength(0);
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_failed");
  });
});
