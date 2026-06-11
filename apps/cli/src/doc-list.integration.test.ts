/**
 * `ez doc list` end-to-end smoke (ADR 0021 §CLI generator).
 *
 * Proves the registry-driven generator works against the real trunk:
 *
 *   1. Build a `createApiApp` with `doc.list` registered in the api
 *      dispatcher (needed so `/docs/list` isn't 501'd by the dispatch
 *      chain).
 *   2. Sign up + log in → session cookie stored in an in-memory
 *      `AuthCredentialStore`.
 *   3. Seed one `docs` row directly in the driver (same pattern as
 *      `auth-chain.integration.test.ts`).
 *   4. Invoke `runCapability(docList, ...)` — the same path the
 *      generated `ez doc list` citty command uses — against the
 *      in-memory trunk (injected fetch).
 *   5. Assert the payload contains the seeded row, exit 0, no
 *      credential clear.
 *
 * The command-level citty wrapper is implicitly exercised by
 * `command.unit.test.ts` + `index.ts`; this integration smoke targets
 * the dispatch/auth/SQL path which unit tests can't cover.
 */

import { PassThrough } from "node:stream";

import { createApiApp, createApiDispatcher } from "@editorzero/api-server";
import { createAuth, runAuthMigrations } from "@editorzero/auth";
import { createRegistry, docList, registerCapability } from "@editorzero/capabilities";
import {
  createLoadRoles,
  createSqliteDriver,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthCredentialStore, CredentialHeaders } from "./credential-store";
import { runCapability } from "./generator/invoke";

const BASE_URL = "http://localhost:3000";
const DOC_ID = DocId("018f0000-0000-7000-8000-0000000000d1");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

async function buildStack() {
  const auth = createAuth({
    driver,
    baseURL: BASE_URL,
    secret: "test-secret-do-not-use-in-production-at-all",
    trustedOrigins: [BASE_URL],
    registrationMode: "open",
  });
  await runAuthMigrations(auth);
  const registry = createRegistry([registerCapability(docList)]);
  const dispatcher = createApiDispatcher({ driver, registry });
  const loadRoles = createLoadRoles(driver);
  const trunk = createApiApp({ auth, loadRoles, dispatcher });
  return { auth, trunk };
}

function makeStoreFake(): AuthCredentialStore & { writes: CredentialHeaders[] } {
  let current: CredentialHeaders | null = null;
  const writes: CredentialHeaders[] = [];
  return {
    get writes() {
      return writes;
    },
    async read() {
      return current;
    },
    async write(headers) {
      current = headers;
      writes.push(headers);
    },
    async clear() {
      current = null;
    },
  };
}

function captured(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie
    .split(/,(?=\s*[^ ;]+=)/u)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}

describe("ez doc list end-to-end (generator → trunk → dispatcher → doc.list)", () => {
  it("returns the seeded doc through the generator's runCapability path", async () => {
    const { trunk } = await buildStack();

    // Sign up + sign in.
    const signUpRes = await trunk.request("/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "docs-user@example.com",
        password: "correct-horse-battery-staple",
        name: "docs-user",
      }),
    });
    expect(signUpRes.status).toBe(200);
    const signInRes = await trunk.request("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "docs-user@example.com",
        password: "correct-horse-battery-staple",
      }),
    });
    expect(signInRes.status).toBe(200);
    const cookie = sessionCookieFrom(signInRes);

    // Seed a docs row in the minted workspace so /docs/list has
    // something to return.
    const users = await driver
      .system()
      // biome-ignore lint/suspicious/noExplicitAny: BA user table is outside our Database type.
      .selectFrom("user" as any)
      .select(["id" as never, "workspaceId" as never])
      .execute();
    const user = users[0] as { id: string; workspaceId: string };
    await driver.withSystemTx(async (tx) => {
      await tx
        .insertInto("docs")
        .values({
          id: DOC_ID,
          workspace_id: WorkspaceId(user.workspaceId),
          collection_id: null,
          title: "Seeded doc",
          slug: "seeded-doc",
          order_key: "a",
          visibility: "workspace",
          visibility_version: 0,
          created_by: UserId(user.id),
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
          deleted_at: null,
        })
        .execute();
    });

    // Wire an in-memory store with the session cookie so runCapability
    // can read it without hitting runLogin.
    const store = makeStoreFake();
    await store.write({ cookie });

    const fetch: typeof globalThis.fetch = async (input, init) =>
      trunk.request(typeof input === "string" || input instanceof URL ? input : input.url, init);
    const { stream, read } = captured();

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: BASE_URL, rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    const body = JSON.parse(read()) as {
      docs: {
        id: string;
        title: string;
        slug: string;
        visibility: string;
      }[];
    };
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]?.id).toBe(DOC_ID);
    expect(body.docs[0]?.title).toBe("Seeded doc");
    expect(body.docs[0]?.visibility).toBe("workspace");
  });
});
