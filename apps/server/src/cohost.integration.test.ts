/**
 * Co-hosting + auth smoke (ADR 0027 / 0030, deliverable #2).
 *
 * Proves the single-box topology AND its security edge on one `http.Server`,
 * end-to-end through the real surfaces:
 *
 *   1. HTTP trunk (health) + static SPA assets (`serveStatic`) on one port.
 *   2. Collab WebSocket upgrade co-hosted via raw `ws`
 *      (`WebSocketServer({ noServer })` + `server.on("upgrade")`) — the same
 *      mechanism `@hocuspocus/server`'s own `Server.ts` uses in-tree, so
 *      `@hono/node-server` **v1** suffices (ADR 0027's "v2 prerequisite"
 *      framing is retired).
 *   3. **authN at the upgrade** — the session cookie is resolved to a
 *      principal through the *shared* Better Auth resolver (`booted.resolver`,
 *      invariant 5); no principal → the socket is destroyed before the WS
 *      establishes.
 *   4. **authZ at `onAuthenticate`** — Hocuspocus multiplexes documents per
 *      socket, so per-document authorization runs where the doc name is known.
 *      The injected principal (`handleConnection(ws, req, { principal })`,
 *      surfaced as `payload.context`) is checked against the multiplexed
 *      `documentName` by reusing the tenant-scoping floor; a throw denies.
 *
 * Security note (verified in @hocuspocus/server 3.4.4 `ClientConnection.ts`):
 * the gate is fail-closed — non-Auth frames are queued, never applied, and a
 * document is established (and the queue flushed) only after a *successful*
 * Auth frame. But the gate keys on the Auth frame, not on hook presence: with
 * **no** `onAuthenticate`, any Auth frame establishes full read/write. So
 * "`onAuthenticate` is registered and throws on deny" is the only backstop —
 * the production WS attach enforces it by *construction* (a single
 * `createAuthenticatedCollabHocuspocus` factory that always installs the hook,
 * with a negative test that a hook-less instance is never on the production
 * path), not by a runtime boot-time assertion.
 *
 * Scope: this proves co-hosting + cookie authN + per-doc authZ *feasibility*,
 * not the final production sync topology (one shared Hocuspocus instance + a
 * WS attach hook exposed from the booted app + broadcast-after-commit) — that
 * is the ADR 0027 production pass. The client speaks only the Hocuspocus auth
 * handshake (not full y-sync), which is all the auth edge requires.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BootedApp, getApiApp } from "@editorzero/api-server";
import { parseRuntimeConfig } from "@editorzero/config";
import { DocId, WorkspaceId } from "@editorzero/ids";
import { readAuthMessage, writeAuthentication } from "@hocuspocus/common";
import { Hocuspocus, MessageType } from "@hocuspocus/server";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RawData, WebSocket, WebSocketServer } from "ws";

import { portOf } from "./runtime";

const TEST_SECRET = "test-secret-do-not-use-in-production-cohost";
const PASSWORD = "smoke-password-123";
const WS_TIMEOUT_MS = 3000;

function boot(): Promise<BootedApp> {
  return getApiApp({
    config: parseRuntimeConfig({
      EDITORZERO_PUBLIC_ORIGIN: "http://localhost:3000",
      DATABASE_URL: ":memory:",
    }),
    secret: TEST_SECRET,
  });
}

/**
 * Pull a `WorkspaceId` out of the (Hocuspocus-typed `any`) connection
 * context. Treated as `unknown` and validated structurally — no cast — so a
 * malformed context fails closed (returns null → `onAuthenticate` throws).
 */
function principalWorkspaceId(context: unknown): WorkspaceId | null {
  if (typeof context !== "object" || context === null || !("principal" in context)) {
    return null;
  }
  const principal = context.principal;
  if (typeof principal !== "object" || principal === null || !("workspace_id" in principal)) {
    return null;
  }
  const workspaceId = principal.workspace_id;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;
  return WorkspaceId(workspaceId);
}

/**
 * Bare Hocuspocus core (no storage extension) whose only job here is the
 * per-document authZ gate. authN already ran at the upgrade, so
 * `context.principal` is present; we authorize `documentName` against the
 * principal's workspace via a tenant-scoped lookup (the doc row is visible
 * only inside its own workspace), and throw to deny.
 */
function buildHocuspocus(booted: BootedApp): Hocuspocus {
  return new Hocuspocus({
    onAuthenticate: async ({ context, documentName }) => {
      const workspaceId = principalWorkspaceId(context);
      if (workspaceId === null) {
        throw new Error("forbidden: no resolved principal on the connection");
      }
      const row = await booted.driver
        .scoped(workspaceId)
        .selectFrom("docs")
        .where("id", "=", DocId(documentName))
        .where("deleted_at", "is", null)
        .select("id")
        .executeTakeFirst();
      if (row === undefined) {
        throw new Error("forbidden: document is not in the principal's workspace");
      }
    },
  });
}

interface CoHost {
  readonly port: number;
  readonly close: () => Promise<void>;
}

async function coHost(
  booted: BootedApp,
  staticRoot: string,
  hocuspocus: Hocuspocus,
): Promise<CoHost> {
  booted.app.use("/assets/*", serveStatic({ root: staticRoot }));

  const server = createServer(getRequestListener(booted.app.fetch));
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      try {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname !== "/collab") {
          socket.destroy();
          return;
        }
        // authN: resolve the session cookie through the shared resolver.
        const headers = new Headers();
        if (typeof req.headers.cookie === "string") headers.set("cookie", req.headers.cookie);
        const principal = await booted.resolver(headers);
        if (principal === null) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (client) => {
          hocuspocus.handleConnection(client, req, { principal });
        });
      } catch {
        // Fail closed: any resolution error refuses the upgrade.
        socket.destroy();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });

  const close = async (): Promise<void> => {
    wss.close();
    hocuspocus.closeConnections();
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await booted.close();
  };

  return { port: portOf(server.address(), 0), close };
}

async function signUp(port: number, email: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
  if (!res.ok) throw new Error(`sign-up failed (${res.status}): ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0] ?? "")
    .filter((part) => part.length > 0)
    .join("; ");
  if (cookie.length === 0) throw new Error("sign-up returned no Set-Cookie");
  return cookie;
}

async function createDoc(port: number, cookie: string, title: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/docs/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`doc.create failed (${res.status}): ${await res.text()}`);
  const body: unknown = await res.json();
  if (typeof body === "object" && body !== null && "doc_id" in body) {
    const docId = body.doc_id;
    if (typeof docId === "string" && docId.length > 0) return docId;
  }
  throw new Error("doc.create response missing doc_id");
}

function rawToUint8(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

/** Encode a Hocuspocus client Auth frame: documentName, MessageType.Auth, token. */
function buildAuthFrame(documentName: string, token: string): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, MessageType.Auth);
  writeAuthentication(encoder, token);
  return toUint8Array(encoder);
}

/** Decode a server frame; returns the terminal auth outcome, else null. */
function decodeAuthResponse(data: Uint8Array): "authenticated" | "denied" | null {
  const decoder = createDecoder(data);
  readVarString(decoder); // documentName
  if (readVarUint(decoder) !== MessageType.Auth) return null;
  let result: "authenticated" | "denied" | null = null;
  readAuthMessage(
    decoder,
    () => {
      /* TokenSyncRequest — server prompting; non-terminal (we already sent). */
    },
    () => {
      result = "denied";
    },
    () => {
      result = "authenticated";
    },
  );
  return result;
}

type AuthOutcome = "authenticated" | "denied" | "rejected";

/**
 * Open a collab WS (optionally with a session cookie on the upgrade), send the
 * Auth frame for `documentName`, and resolve with the outcome: "rejected" if
 * the upgrade itself is refused (authN), "authenticated" / "denied" from the
 * Hocuspocus auth response (authZ).
 */
function wsAuth(port: number, documentName: string, cookie: string | null): Promise<AuthOutcome> {
  return new Promise((resolve, reject) => {
    const client =
      cookie === null
        ? new WebSocket(`ws://127.0.0.1:${port}/collab`)
        : new WebSocket(`ws://127.0.0.1:${port}/collab`, { headers: { cookie } });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.terminate();
      reject(new Error("ws auth handshake timed out"));
    }, WS_TIMEOUT_MS);
    const finish = (outcome: AuthOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      resolve(outcome);
    };
    client.on("open", () => client.send(buildAuthFrame(documentName, "smoke-session-token")));
    client.on("message", (data) => {
      const outcome = decodeAuthResponse(rawToUint8(data));
      if (outcome !== null) finish(outcome);
    });
    client.on("error", () => finish("rejected"));
    client.on("close", () => finish("rejected"));
  });
}

/**
 * Open one collab WS with a session cookie, then run the Auth handshake for
 * `docFirst` then `docSecond` *on the same socket*, returning both outcomes in
 * order. This pins the multiplex concern that forced authZ into
 * `onAuthenticate`: Hocuspocus gates each `documentName` independently over a
 * shared socket, so authenticating one document must not establish another — a
 * cross-workspace doc sent over an already-authenticated socket must still be
 * denied. The second frame is sent only after the first terminal response, so
 * the outcomes map to send order (interleaved sync frames decode to null and
 * are skipped by `decodeAuthResponse`).
 */
function wsAuthSameSocket(
  port: number,
  cookie: string,
  docFirst: string,
  docSecond: string,
): Promise<readonly [AuthOutcome, AuthOutcome]> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/collab`, { headers: { cookie } });
    let first: AuthOutcome | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.terminate();
      reject(new Error("ws same-socket auth handshake timed out"));
    }, WS_TIMEOUT_MS);
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ws closed mid same-socket handshake (first outcome: ${first ?? "none"})`));
    };
    client.on("open", () => client.send(buildAuthFrame(docFirst, "smoke-session-token")));
    client.on("message", (data) => {
      if (settled) return;
      const outcome = decodeAuthResponse(rawToUint8(data));
      if (outcome === null) return;
      if (first === null) {
        first = outcome;
        client.send(buildAuthFrame(docSecond, "smoke-session-token"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.close();
      resolve([first, outcome]);
    });
    client.on("error", fail);
    client.on("close", fail);
  });
}

describe("co-hosting + auth (deliverable #2)", () => {
  let host: CoHost | undefined;
  let booted: BootedApp | undefined;
  let staticRoot: string | undefined;
  let cookieA = "";
  let cookieB = "";
  let docInA = "";
  let docInB = "";

  function activePort(): number {
    if (host === undefined) throw new Error("coHost not started");
    return host.port;
  }

  beforeAll(async () => {
    staticRoot = await mkdtemp(join(tmpdir(), "ez-cohost-"));
    await mkdir(join(staticRoot, "assets"));
    await writeFile(join(staticRoot, "assets", "app.js"), "globalThis.__ez_spa = true;\n");

    booted = await boot();
    host = await coHost(booted, staticRoot, buildHocuspocus(booted));

    cookieA = await signUp(host.port, "alice@example.com");
    cookieB = await signUp(host.port, "bob@example.com");
    docInA = await createDoc(host.port, cookieA, "Alice's smoke doc");
    docInB = await createDoc(host.port, cookieB, "Bob's smoke doc");
  });

  afterAll(async () => {
    await host?.close();
    await booted?.close();
    if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
  });

  it("serves the HTTP trunk and static SPA assets on the collab port", async () => {
    const health = await fetch(`http://127.0.0.1:${activePort()}/infra/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    const asset = await fetch(`http://127.0.0.1:${activePort()}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("__ez_spa");
  });

  it("rejects a collab upgrade with no session cookie (authN at upgrade)", async () => {
    expect(await wsAuth(activePort(), docInA, null)).toBe("rejected");
  });

  it("authenticates a collab connection for a doc in the principal's workspace", async () => {
    expect(await wsAuth(activePort(), docInA, cookieA)).toBe("authenticated");
  });

  it("denies a collab connection for a doc in another workspace (authZ at onAuthenticate)", async () => {
    expect(await wsAuth(activePort(), docInA, cookieB)).toBe("denied");
  });

  it("gates each document independently on one socket (same-socket multiplex authZ)", async () => {
    // Alice authenticates her own doc, then sends an Auth frame for Bob's doc
    // over the *same* socket: the first establishes, the second is denied —
    // proving per-document authZ holds across a multiplexed connection.
    const [first, second] = await wsAuthSameSocket(activePort(), cookieA, docInA, docInB);
    expect(first).toBe("authenticated");
    expect(second).toBe("denied");
  });
});
