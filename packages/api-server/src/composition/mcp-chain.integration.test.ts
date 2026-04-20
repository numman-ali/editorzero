/**
 * MCP chain integration test — trunk + Better Auth + principal chain +
 * dispatcher + `createMcpHandler` against a real in-memory SQLite +
 * HocuspocusSync stack (ADR 0026).
 *
 * Proves the MCP adapter works end-to-end with the same auth chain
 * `/docs/*` uses (commitment 1 — session cookie resolves to
 * `c.var.principal`; no `authInfo.extra.principal`). The in-process
 * `packages/mcp-server/src/create-mcp-handler.integration.test.ts`
 * test exercises the adapter in isolation (Hono + fake dispatcher); this
 * file exercises it behind real cookie auth + a real dispatcher
 * hitting SQLite + Hocuspocus.
 *
 * Four cases:
 *
 *  1. `tools/list` with a valid session cookie — every registered
 *     capability whose surfaces include "mcp" appears as a tool.
 *  2. `tools/call` on `doc.list` with the cookie — dispatches through
 *     the real stack, returns the empty-workspace doc list.
 *  3. `tools/call` on `doc.create` with the cookie — creates a doc,
 *     returns the doc_id + seed_blocks (content mutation through the
 *     full write-path tx + Hocuspocus).
 *  4. Any MCP request without the cookie — 401 at the principal
 *     middleware (before any MCP handler code runs).
 */

import { createAuth, runAuthMigrations } from "@editorzero/auth";
import {
  createRegistry,
  docCreate,
  docDelete,
  docGet,
  docList,
  docPublish,
  docRestore,
  docUnpublish,
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
import { HocuspocusSync } from "@editorzero/sync";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiApp } from "../app";
import { createApiDispatcher } from "./createApiDispatcher";

let driver: SqliteDriver;
const openSyncs: HocuspocusSync[] = [];
const openClients: Client[] = [];

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  while (openClients.length > 0) {
    const client = openClients.pop();
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // Client close can throw if the underlying transport is already
        // closed; the test has asserted what it needs — don't fail
        // afterEach on cleanup noise.
      }
    }
  }
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

async function buildStack() {
  const auth = createAuth({
    driver,
    baseURL: "http://localhost:3000",
    secret: "test-secret-do-not-use-in-production-at-all",
    trustedOrigins: ["http://localhost:3000"],
  });
  await runAuthMigrations(auth);
  // Register the full P3.7 production doc capability set. The literal
  // slice (just docList + docCreate) was fine while this test only
  // asserted two literal ids on tools/list, but the derivation-parity
  // case below proves the stronger invariant (AGENTS.md #4): every
  // mcp-surface capability in the registry is exposed as a tool through
  // the real trunk composition — not just the ones we remembered to
  // mention in a hand-written assertion. Registration is inline per
  // capability because `registerCapability<I, O>` can't unify `I` / `O`
  // across heterogeneous capability types in a single `.map(...)`.
  const capabilities = [
    registerCapability(docCreate),
    registerCapability(docDelete),
    registerCapability(docGet),
    registerCapability(docList),
    registerCapability(docPublish),
    registerCapability(docRestore),
    registerCapability(docUnpublish),
  ];
  const registry = createRegistry(capabilities);
  const sync = new HocuspocusSync({
    docUpdatesWriter: createDocUpdatesWriter(),
    docUpdatesReader: createDocUpdatesReader(),
    systemDb: driver.system(),
  });
  openSyncs.push(sync);
  const dispatcher = createApiDispatcher({ driver, registry, sync });
  const loadRoles = createLoadRoles(driver);
  const trunk = createApiApp({
    auth,
    loadRoles,
    dispatcher,
    registry,
    mcpServerInfo: { name: "editorzero-test", version: "0.0.0-test" },
  });
  return { auth, trunk };
}

async function signUpAndSignIn(trunk: Awaited<ReturnType<typeof buildStack>>["trunk"]) {
  const email = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const signupRes = await trunk.request("/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "correct-horse-battery-staple",
      name: "mcp-test",
    }),
  });
  expect(signupRes.status).toBe(200);
  const signinRes = await trunk.request("/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
  expect(signinRes.status).toBe(200);
  const cookie = sessionCookieFrom(signinRes);
  expect(cookie.length).toBeGreaterThan(0);
  return cookie;
}

async function makeMcpClient(
  trunk: Awaited<ReturnType<typeof buildStack>>["trunk"],
  cookie: string,
): Promise<Client> {
  const client = new Client({ name: "editorzero-mcp-test-client", version: "0.0.0" });
  openClients.push(client);
  const url = new URL("http://localhost:3000/mcp");
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const path = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers ?? {});
      headers.set("cookie", cookie);
      return trunk.request(path, { ...(init ?? {}), headers });
    },
  });
  // exactOptionalPropertyTypes friction — see mcp-server's
  // create-mcp-handler.integration.test.ts header.
  await client.connect(transport as Transport);
  return client;
}

describe("MCP chain — trunk + auth + dispatcher + createMcpHandler", () => {
  it("tools/list equals the production registry's mcp-filter — derivation parity through the real trunk", async () => {
    // Contract invariant (AGENTS.md #4 + ADR 0026 commitments 1, 5):
    // every mcp-surface capability the caller registers must appear as
    // a tool in `tools/list` — no silent drops from the adapter, no
    // ghost tools the registry doesn't know about. The expected set is
    // derived from the registered capabilities using the public
    // semantic filter (`surfaces.includes("mcp") && !humanOnly`), not
    // from a hand-maintained literal, so adding a new mcp-surface
    // capability in the production set below makes this test pick it
    // up automatically. The in-adapter version of this assertion lives
    // in `packages/mcp-server/src/create-mcp-handler.integration.test
    // .ts`; this one proves the same contract holds through the real
    // cookie-auth + trunk-composition stack.
    const { trunk } = await buildStack();
    const cookie = await signUpAndSignIn(trunk);
    const client = await makeMcpClient(trunk, cookie);

    const result = await client.listTools();

    const toolNames = result.tools.map((t) => t.name).sort();
    const expected = [docCreate, docDelete, docGet, docList, docPublish, docRestore, docUnpublish]
      .filter((c) => c.surfaces.includes("mcp") && c.humanOnly !== true)
      .map((c) => c.id as string)
      .sort();

    expect(toolNames).toEqual(expected);
    expect(toolNames).toEqual([
      "doc.create",
      "doc.delete",
      "doc.get",
      "doc.list",
      "doc.publish",
      "doc.restore",
      "doc.unpublish",
    ]);
  });

  it("dispatches doc.list via tools/call and returns the empty workspace list", async () => {
    const { trunk } = await buildStack();
    const cookie = await signUpAndSignIn(trunk);
    const client = await makeMcpClient(trunk, cookie);

    const result = await client.callTool({ name: "doc.list", arguments: {} });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]?.text ?? "") as { docs: unknown[] };
    expect(Array.isArray(payload.docs)).toBe(true);
    expect(payload.docs).toEqual([]);
  });

  it("dispatches doc.create via tools/call end-to-end (content mutation through write-path tx)", async () => {
    const { trunk } = await buildStack();
    const cookie = await signUpAndSignIn(trunk);
    const client = await makeMcpClient(trunk, cookie);

    const result = await client.callTool({
      name: "doc.create",
      arguments: { title: "Hello from MCP" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]?.text ?? "") as {
      doc_id: string;
      title: string;
      seed_blocks: Array<{ id: string; type: string }>;
    };
    expect(payload.doc_id).toBeDefined();
    expect(payload.title).toBe("Hello from MCP");
    expect(payload.seed_blocks.length).toBeGreaterThan(0);

    const listResult = await client.callTool({ name: "doc.list", arguments: {} });
    const listContent = listResult.content as Array<{ type: string; text: string }>;
    const listPayload = JSON.parse(listContent[0]?.text ?? "") as {
      docs: Array<{ doc_id: string; title: string }>;
    };
    expect(listPayload.docs.length).toBe(1);
    expect(listPayload.docs[0]?.title).toBe("Hello from MCP");
  });

  it("rejects unauthenticated MCP requests before any MCP handler code runs", async () => {
    const { trunk } = await buildStack();

    // Skip the sign-in step — hit `/mcp` with no cookie.
    const res = await trunk.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "unauth-probe", version: "0.0.0" },
        },
      }),
    });

    expect(res.status).toBe(401);
  });
});
