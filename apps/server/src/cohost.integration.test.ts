/**
 * Production co-hosting + WS-attach hardening (ADR 0027 / 0030, task #15).
 *
 * This suite exercises the REAL production path end-to-end: `getApiApp`
 * (which registers `collabAuthorize` on the embedded Hocuspocus) →
 * `startServer` + `attachCollab` (the exact wiring `apps/server`'s
 * entrypoint mounts) → hand-rolled Hocuspocus protocol clients. The
 * earlier smoke's private bare-Hocuspocus build is gone — WS clients now
 * attach to the SAME instance the dispatcher writes through, which is
 * what the convergence scenario proves.
 *
 * The ADR 0030 red-team blockers, each pinned here:
 *
 *   1. **Write posture** — originally "forced readOnly" (no audited WS
 *      write lane existed); since ADR 0043 landed, the default posture
 *      is LIFTED: the Authenticated frame carries `"read-write"` and
 *      every novel update-bearing frame dispatches `doc.apply_update`
 *      (the write-lane describe). The operator's `collabReadOnly: true`
 *      pin preserves the original contract — attaches succeed, writes
 *      are nacked with NO durable row and NO state change (the pin
 *      describe; Codex review: assert state, not just the denial
 *      frame).
 *   2. **Origin allow-list at upgrade** — wrong AND absent Origin are
 *      refused even with a valid session cookie (the raw upgrade never
 *      passes Better Auth's CORS handling; absent-Origin tolerance only
 *      shields non-browser clients that could fake the header anyway).
 *   3. **Revocation freshness** — sign-out closes the registered
 *      socket server-side with the app-range revocation code (ADR 0043
 *      Decision 5's event-driven tap), and the dead cookie cannot
 *      re-attach. Per-frame principal re-resolution remains the
 *      backstop rail for anything the tap misses; it is pinned at the
 *      sync layer (`ws-attach.integration.test.ts`) and the policy
 *      layer (`collabPolicies.unit.test.ts`).
 *   4. **authZ by construction** — per-document authorization runs in
 *      `HocuspocusSync`'s constructor-registered `onAuthenticate`; the
 *      tenant-scoped lookup + ACL ceiling deny a cross-workspace doc on
 *      a multiplexed socket whose other document authenticated fine.
 *      (A within-workspace ceiling deny needs a second member in one
 *      workspace — no invite surface exists yet; the ceiling term
 *      itself is fuzz-covered by ADR 0040 §8.1a.)
 *
 * Convergence + hydration (the one-instance dividend): a WS client that
 * attaches and syncs receives the doc's COMMITTED state (the `__ws`
 * hydration marker replaying `doc_updates`), and a subsequent HTTP
 * `doc.update` broadcast reaches it live.
 *
 * The suite's teardown is itself an assertion: `running.close()` must
 * settle with a still-attached WS client (the `ServerAttachment` drain
 * terminates upgraded sockets BEFORE `server.close()` waits on them).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BootedApp, COLLAB_REVOKED_CLOSE_CODE, getApiApp } from "@editorzero/api-server";
import { parseRuntimeConfig } from "@editorzero/config";
import { DocId } from "@editorzero/ids";
import { DOC_FRAGMENT } from "@editorzero/sync";
import { readAuthMessage, writeAuthentication } from "@hocuspocus/common";
import { MessageType } from "@hocuspocus/server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RawData, WebSocket } from "ws";
import * as Y from "yjs";

import { attachCollab } from "./collab";
import { type RunningServer, startServer } from "./runtime";

const TEST_SECRET = "test-secret-do-not-use-in-production-cohost";
const PASSWORD = "smoke-password-123";
const PUBLIC_ORIGIN = "http://localhost:3000";
const WS_TIMEOUT_MS = 3000;

/** y-protocols sync sub-message tags (stable wire constants). */
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

function boot(collabReadOnly?: boolean): Promise<BootedApp> {
  return getApiApp({
    config: parseRuntimeConfig({
      EDITORZERO_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      DATABASE_URL: ":memory:",
      // The smoke signs up multiple principals; the first-user gate
      // has its own coverage in packages/auth.
      EDITORZERO_REGISTRATION_MODE: "open",
    }),
    secret: TEST_SECRET,
    // ADR 0043: default (false) = lifted production posture — WS
    // writes flow through the audited dispatch gate. The pin suite
    // passes TRUE to cover the operator's emergency read-only knob.
    ...(collabReadOnly !== undefined && { collabReadOnly }),
  });
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

async function createAgent(port: number, cookie: string, name: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/agents/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`agent.create failed (${res.status}): ${await res.text()}`);
  const body: unknown = await res.json();
  if (typeof body === "object" && body !== null && "agent_id" in body) {
    const agentId = body.agent_id;
    if (typeof agentId === "string" && agentId.length > 0) return agentId;
  }
  throw new Error("agent.create response missing agent_id");
}

/** Mint a show-once read-only agent token (`ez_agent_…`) for `agentId`. */
async function mintReadOnlyToken(port: number, cookie: string, agentId: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/agents/token_mint/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ tier: "read-only" }),
  });
  if (!res.ok) throw new Error(`agent.token_mint failed (${res.status}): ${await res.text()}`);
  const body: unknown = await res.json();
  if (typeof body === "object" && body !== null && "token" in body) {
    const token = body.token;
    if (typeof token === "string" && token.length > 0) return token;
  }
  throw new Error("agent.token_mint response missing token");
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

/** SyncStep1 with an EMPTY state vector — asks the server for full state. */
function buildSyncStep1Frame(documentName: string): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, MessageType.Sync);
  writeVarUint(encoder, SYNC_STEP1);
  // An empty Yjs state vector encodes as a single varuint 0.
  writeVarUint8Array(encoder, new Uint8Array([0]));
  return toUint8Array(encoder);
}

/** A raw Yjs Update frame carrying `update` — what a WRITING client sends. */
function buildUpdateFrame(documentName: string, update: Uint8Array): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, MessageType.Sync);
  writeVarUint(encoder, SYNC_UPDATE);
  writeVarUint8Array(encoder, update);
  return toUint8Array(encoder);
}

/** A SyncStep2 frame — the OTHER update-bearing subtype the gate covers. */
function buildSyncStep2Frame(documentName: string, update: Uint8Array): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, MessageType.Sync);
  writeVarUint(encoder, SYNC_STEP2);
  writeVarUint8Array(encoder, update);
  return toUint8Array(encoder);
}

/** The unaudited cross-client relay ADR 0043 Decision 3 shuts. */
function buildBroadcastStatelessFrame(documentName: string, payload: string): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, MessageType.BroadcastStateless);
  writeVarString(encoder, payload);
  return toUint8Array(encoder);
}

/** A message type no client legitimately sends (native would ignore it). */
function buildUnknownTypeFrame(documentName: string): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, 42);
  return toUint8Array(encoder);
}

type AuthOutcome = "authenticated" | "denied" | "rejected";

interface AuthResult {
  readonly outcome: AuthOutcome;
  /** `"readonly"` / `"read-write"` from the Authenticated frame; null otherwise. */
  readonly scope: string | null;
}

/**
 * Minimal hand-rolled Hocuspocus client over one socket — enough
 * protocol to (a) run Auth handshakes for any number of documents,
 * (b) pull full document state via SyncStep1→SyncStep2 and follow live
 * Update broadcasts into a local `Y.Doc`, (c) send raw update frames,
 * and (d) observe `SyncStatus` acks. No reconnect, no awareness — the
 * auth/convergence edges are all this suite needs.
 */
class CollabClient {
  readonly #ws: WebSocket;
  readonly #open: Promise<void>;
  /** Local replicas, keyed by documentName, fed by SyncStep2/Update frames. */
  readonly docs = new Map<string, Y.Doc>();
  /** Per-document Close frames received (refused per-doc connections land here). */
  readonly #docCloses = new Map<string, string>();
  #pendingAuth: ((result: AuthResult) => void) | null = null;
  #pendingSyncStatus: ((saved: boolean) => void) | null = null;
  #closed = false;
  /** Socket-level close (code + reason) — how a revocation close lands. */
  #socketClose: { code: number; reason: string } | null = null;

  constructor(port: number, headers: Record<string, string>) {
    this.#ws = new WebSocket(`ws://127.0.0.1:${port}/collab`, { headers });
    this.#open = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timed out")), WS_TIMEOUT_MS);
      this.#ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#ws.on("error", () => {
        clearTimeout(timer);
        reject(new Error("ws upgrade rejected"));
      });
    });
    this.#ws.on("close", (code, reason) => {
      this.#closed = true;
      this.#socketClose = { code, reason: reason.toString() };
      this.#pendingAuth?.({ outcome: "rejected", scope: null });
      this.#pendingAuth = null;
    });
    this.#ws.on("message", (data) => this.#onMessage(rawToUint8(data)));
  }

  #onMessage(frame: Uint8Array): void {
    const decoder = createDecoder(frame);
    const documentName = readVarString(decoder);
    const type = readVarUint(decoder);
    if (type === MessageType.Auth) {
      let result: AuthResult | null = null;
      readAuthMessage(
        decoder,
        () => {
          /* TokenSyncRequest — non-terminal (we already sent the token). */
        },
        () => {
          result = { outcome: "denied", scope: null };
        },
        (scope) => {
          result = { outcome: "authenticated", scope };
        },
      );
      if (result !== null && this.#pendingAuth !== null) {
        const settle = this.#pendingAuth;
        this.#pendingAuth = null;
        settle(result);
      }
      return;
    }
    if (type === MessageType.Sync || type === MessageType.SyncReply) {
      const sub = readVarUint(decoder);
      if (sub === SYNC_STEP2 || sub === SYNC_UPDATE) {
        const update = readVarUint8Array(decoder);
        const doc = this.docs.get(documentName);
        if (doc !== undefined) Y.applyUpdate(doc, update);
      }
      // SyncStep1 from the server (asking for OUR state) is ignored —
      // these clients never volunteer state.
      return;
    }
    if (type === MessageType.SyncStatus) {
      const saved = readVarUint(decoder) === 1;
      if (this.#pendingSyncStatus !== null) {
        const settle = this.#pendingSyncStatus;
        this.#pendingSyncStatus = null;
        settle(saved);
      }
      return;
    }
    if (type === MessageType.CLOSE) {
      // The server severed THIS document's connection (multiplexed
      // per-doc close) — how a refused write/frame manifests.
      this.#docCloses.set(documentName, readVarString(decoder));
    }
  }

  /** Run the Auth handshake for `documentName` on this socket. */
  async attach(documentName: string): Promise<AuthResult> {
    await this.#open.catch(() => {
      /* fall through — rejected upgrades settle below */
    });
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) {
      return { outcome: "rejected", scope: null };
    }
    return new Promise<AuthResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("auth handshake timed out")), WS_TIMEOUT_MS);
      this.#pendingAuth = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.#ws.send(buildAuthFrame(documentName, "smoke-session-token"));
    });
  }

  /** Ask for full state; SyncStep2 + later broadcasts feed `this.docs`. */
  startSync(documentName: string): void {
    this.docs.set(documentName, new Y.Doc());
    this.#ws.send(buildSyncStep1Frame(documentName));
  }

  /** Send a raw Yjs update; resolve with the server's SyncStatus ack. */
  sendUpdate(documentName: string, update: Uint8Array): Promise<boolean> {
    return this.sendForAck(buildUpdateFrame(documentName, update));
  }

  /** Send any ack-bearing frame; resolve with the SyncStatus answer. */
  sendForAck(frame: Uint8Array): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sync status timed out")), WS_TIMEOUT_MS);
      this.#pendingSyncStatus = (saved) => {
        clearTimeout(timer);
        resolve(saved);
      };
      this.#ws.send(frame);
    });
  }

  /** Send raw bytes — refusal-path tests hand-craft hostile frames. */
  sendRaw(frame: Uint8Array): void {
    this.#ws.send(frame);
  }

  /** Resolve with the Close reason once the server severs `documentName`. */
  async waitForDocClose(documentName: string): Promise<string> {
    const deadline = Date.now() + WS_TIMEOUT_MS;
    for (;;) {
      const reason = this.#docCloses.get(documentName);
      if (reason !== undefined) return reason;
      if (Date.now() > deadline) throw new Error("timed out waiting for per-doc Close frame");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Resolve with `{code, reason}` once the SOCKET itself closes. */
  async waitForSocketClose(): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + WS_TIMEOUT_MS;
    for (;;) {
      if (this.#socketClose !== null) return this.#socketClose;
      if (Date.now() > deadline) throw new Error("timed out waiting for socket close");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Poll the local replica until its fragment text contains `needle`. */
  async waitForText(documentName: string, needle: string): Promise<string> {
    const deadline = Date.now() + WS_TIMEOUT_MS;
    for (;;) {
      const doc = this.docs.get(documentName);
      const text = doc?.getXmlFragment(DOC_FRAGMENT).toString() ?? "";
      if (text.includes(needle)) return text;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for "${needle}" in: ${text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  close(): void {
    this.#ws.close();
  }
}

describe("production WS attach (ADR 0030 hardening)", () => {
  let booted: BootedApp | undefined;
  let running: RunningServer | undefined;
  let staticRoot: string | undefined;
  /** Left deliberately attached so teardown proves the drain (see header). */
  let lingering: CollabClient | undefined;
  let cookieA = "";
  let cookieB = "";
  let docInA = "";
  let docInB = "";
  let docInB2 = "";

  function activePort(): number {
    if (running === undefined) throw new Error("server not started");
    return running.port;
  }

  function openClient(headers: Record<string, string>): CollabClient {
    return new CollabClient(activePort(), headers);
  }

  beforeAll(async () => {
    staticRoot = await mkdtemp(join(tmpdir(), "ez-cohost-"));
    await mkdir(join(staticRoot, "assets"));
    await writeFile(join(staticRoot, "assets", "app.js"), "globalThis.__ez_spa = true;\n");

    booted = await boot();
    booted.app.use("/assets/*", serveStatic({ root: staticRoot }));
    // The production wiring, verbatim: attachCollab mounted through
    // startServer's attachment seam (what apps/server's entrypoint does).
    const bootedNow = booted;
    running = await startServer(bootedNow, 0, [
      (server) => attachCollab(server, bootedNow, { publicOrigin: PUBLIC_ORIGIN }),
    ]);

    cookieA = await signUp(running.port, "alice@example.com");
    cookieB = await signUp(running.port, "bob@example.com");
    docInA = await createDoc(running.port, cookieA, "Alice's smoke doc");
    docInB = await createDoc(running.port, cookieB, "Bob's smoke doc");
    docInB2 = await createDoc(running.port, cookieB, "Bob's second doc");
  });

  afterAll(async () => {
    // `lingering` is still attached: close() must settle anyway — the
    // ServerAttachment drain terminates upgraded sockets before
    // `server.close()` waits on connections. A hang here IS the failure.
    await running?.close();
    lingering?.close();
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
    const client = openClient({ origin: PUBLIC_ORIGIN });
    expect((await client.attach(docInA)).outcome).toBe("rejected");
    client.close();
  });

  it("rejects a valid-cookie upgrade from a foreign Origin", async () => {
    const client = openClient({ origin: "http://evil.example", cookie: cookieA });
    expect((await client.attach(docInA)).outcome).toBe("rejected");
    client.close();
  });

  it("rejects a valid-cookie upgrade with NO Origin header", async () => {
    const client = openClient({ cookie: cookieA });
    expect((await client.attach(docInA)).outcome).toBe("rejected");
    client.close();
  });

  it("authenticates an in-workspace doc with read-write scope (ADR 0043 lifted posture)", async () => {
    const client = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieA });
    const result = await client.attach(docInA);
    expect(result.outcome).toBe("authenticated");
    // The default posture is lifted: WS writes are admitted — every
    // novel frame dispatches `doc.apply_update` through the audited
    // gate (pinned in the write-lane describe below). The operator's
    // read-only pin keeps the old posture (its own describe below).
    expect(result.scope).toBe("read-write");
    client.close();
  });

  it("denies a collab attach for a doc in another workspace (authZ per Auth frame)", async () => {
    const client = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieB });
    expect((await client.attach(docInA)).outcome).toBe("denied");
    client.close();
  });

  it("gates each document independently on one socket (multiplex authZ)", async () => {
    // Alice authenticates her own doc, then sends an Auth frame for
    // Bob's doc over the SAME socket: the first establishes, the second
    // is denied — per-document authZ holds across multiplexing.
    const client = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieA });
    expect((await client.attach(docInA)).outcome).toBe("authenticated");
    expect((await client.attach(docInB)).outcome).toBe("denied");
    client.close();
  });

  it("closes the per-doc connection on a BroadcastStateless frame (ADR 0043 rail, live in production posture)", async () => {
    const client = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieA });
    expect((await client.attach(docInA)).outcome).toBe("authenticated");
    client.sendRaw(buildBroadcastStatelessFrame(docInA, "relay me"));
    await client.waitForDocClose(docInA);
    client.close();
  });

  it("closes the per-doc connection on an unknown message type (total classification)", async () => {
    const client = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieA });
    expect((await client.attach(docInA)).outcome).toBe("authenticated");
    client.sendRaw(buildUnknownTypeFrame(docInA));
    await client.waitForDocClose(docInA);
    client.close();
  });

  it("hydrates committed state on attach and converges live HTTP writes (one instance)", async () => {
    const client = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieA });
    expect((await client.attach(docInA)).outcome).toBe("authenticated");
    client.startSync(docInA);

    // Hydration: the SyncStep2 reply must carry the doc.create-committed
    // state (the `__ws` onLoadDocument branch replaying doc_updates).
    await client.waitForText(docInA, "Alice's smoke doc");

    // Convergence: an HTTP doc.update lands in the SAME embedded
    // Hocuspocus and broadcasts to the attached readOnly client.
    const res = await fetch(`http://127.0.0.1:${activePort()}/docs/update/${docInA}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({
        ops: [
          {
            op: "insert",
            block: { type: "paragraph", content: "Converged over HTTP" },
            after_block_id: null,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    await client.waitForText(docInA, "Converged over HTTP");
    client.close();
  });

  it("closes the live socket at sign-out (ADR 0043 Decision 5) and refuses the dead cookie's re-attach", async () => {
    const client = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieB });
    expect((await client.attach(docInB)).outcome).toBe("authenticated");

    const signOut = await fetch(`http://127.0.0.1:${activePort()}/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieB },
      body: "{}",
    });
    expect(signOut.ok).toBe(true);

    // The sign-out arm of the revocation tap closes the registered
    // socket server-side, event-driven — the client does not get to
    // keep a passive broadcast feed on revoked standing. (Per-frame
    // re-resolution remains the backstop rail for anything the tap
    // misses — pinned at the sync/composition layers.) The app-range
    // close code tells a legitimate client "re-auth, don't blind-retry".
    const closed = await client.waitForSocketClose();
    expect(closed.code).toBe(COLLAB_REVOKED_CLOSE_CODE);
    expect(closed.reason).toBe("authorization revoked");

    // Reconnecting with the dead cookie refuses at upgrade (authN).
    const again = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieB });
    expect((await again.attach(docInB2)).outcome).toBe("rejected");
    again.close();
    client.close();
  });

  it("rejects a WS upgrade carrying an unminted Bearer token (bearer lane, no Origin)", async () => {
    // A well-formed-but-never-minted agent token: the composed resolver
    // returns null → the upgrade is refused (401) → no socket. NO Origin
    // header — proving the refusal is the RESOLVER, not the cookie-lane
    // Origin gate (a bearer upgrade skips it). ADR 0044 Decision 5 step 2.
    const unminted = `Bearer ez_agent_${"0".repeat(43)}`;
    const client = openClient({ authorization: unminted });
    expect((await client.attach(docInA)).outcome).toBe("rejected");
    client.close();
  });

  it("admits a minted-Bearer agent over WS with NO Origin, then closes it on agent-revoke (4401)", async () => {
    const agentId = await createAgent(activePort(), cookieA, "ws-reader-bot");
    const token = await mintReadOnlyToken(activePort(), cookieA, agentId);

    // Bearer ONLY — no cookie, NO Origin. A browser cannot set custom
    // headers on a WS upgrade, so a bearer upgrade is not CSRF-able and
    // skips the Origin gate; were Origin enforced here the upgrade would
    // be REJECTED. The agent reads Alice's workspace-root doc (read-only
    // tier → doc:read; the no-collection placement reads for any subject).
    const agent = openClient({ authorization: `Bearer ${token}` });
    expect((await agent.attach(docInA)).outcome).toBe("authenticated");

    // The socket was registered as an AGENT (ADR 0044 Decision 5):
    // revoking the agent fires the tap's `agent.revoke` arm → closeByAgent
    // → the live socket closes server-side with the app-range code.
    const revoke = await fetch(`http://127.0.0.1:${activePort()}/agents/revoke/${agentId}`, {
      method: "POST",
      headers: { cookie: cookieA },
    });
    expect(revoke.ok).toBe(true);

    const closed = await agent.waitForSocketClose();
    expect(closed.code).toBe(COLLAB_REVOKED_CLOSE_CODE);
    expect(closed.reason).toBe("authorization revoked");
    agent.close();
  });

  it("keeps one client attached for the teardown drain proof", async () => {
    lingering = openClient({ origin: PUBLIC_ORIGIN, cookie: cookieA });
    expect((await lingering.attach(docInA)).outcome).toBe("authenticated");
    // Deliberately NOT closed — afterAll's running.close() must settle
    // while this socket is live (ServerAttachment terminates it).
  });
});

describe("audited WS write lane (ADR 0043 Decision 3 — the default posture)", () => {
  let booted: BootedApp | undefined;
  let running: RunningServer | undefined;
  let cookie = "";
  let docId = "";

  function activePort(): number {
    if (running === undefined) throw new Error("server not started");
    return running.port;
  }

  function openClient(): CollabClient {
    return new CollabClient(activePort(), { origin: PUBLIC_ORIGIN, cookie });
  }

  async function docUpdatesCount(): Promise<number> {
    if (booted === undefined) throw new Error("not booted");
    const rows = await booted.driver
      .system()
      .selectFrom("doc_updates")
      .where("doc_id", "=", DocId(docId))
      .select("id")
      .execute();
    return rows.length;
  }

  /** Audit rows for the WS lane's capability, by outcome — invariant 3's trail. */
  async function applyUpdateAuditCount(outcome: "allow" | "error"): Promise<number> {
    if (booted === undefined) throw new Error("not booted");
    const rows = await booted.driver
      .system()
      .selectFrom("audit_events")
      .where("capability_id", "=", "doc.apply_update")
      .where("outcome", "=", outcome)
      .select("id")
      .execute();
    return rows.length;
  }

  async function docGetBody(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${activePort()}/docs/get/${docId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return res.text();
  }

  function paragraphElement(text: string): Y.XmlElement {
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText(text)]);
    return para;
  }

  /** The attached replica for `docId` — throws if startSync wasn't run. */
  function replicaOf(client: CollabClient): Y.Doc {
    const doc = client.docs.get(docId);
    if (doc === undefined) throw new Error("no local replica — call startSync first");
    return doc;
  }

  beforeAll(async () => {
    // The default production composition — the ADR 0043 lift landed
    // with increment 5, so the audited write lane IS the posture this
    // boot ships with. No knob passed.
    booted = await boot();
    const bootedNow = booted;
    running = await startServer(bootedNow, 0, [
      (server) => attachCollab(server, bootedNow, { publicOrigin: PUBLIC_ORIGIN }),
    ]);
    cookie = await signUp(running.port, "carol@example.com");
    docId = await createDoc(running.port, cookie, "Carol's lane doc");
  });

  afterAll(async () => {
    await running?.close();
  });

  it("authenticates with a read-write grant (default posture)", async () => {
    const client = openClient();
    const result = await client.attach(docId);
    expect(result.outcome).toBe("authenticated");
    expect(result.scope).toBe("read-write");
    client.close();
  });

  it("commits a novel WS update through the audited dispatch lane — ack, rows, audit, broadcast", async () => {
    const writer = openClient();
    expect((await writer.attach(docId)).outcome).toBe("authenticated");
    writer.startSync(docId);
    await writer.waitForText(docId, "Carol's lane doc");

    const watcher = openClient();
    expect((await watcher.attach(docId)).outcome).toBe("authenticated");
    watcher.startSync(docId);
    await watcher.waitForText(docId, "Carol's lane doc");

    const rowsBefore = await docUpdatesCount();
    const auditBefore = await applyUpdateAuditCount("allow");

    // Edit the hydrated replica and send the incremental delta —
    // exactly what a collab provider puts on the wire.
    const replica = replicaOf(writer);
    const before = Y.encodeStateVector(replica);
    replica.getXmlFragment(DOC_FRAGMENT).insert(1, [paragraphElement("WS lane write")]);
    const delta = Y.encodeStateAsUpdate(replica, before);

    const saved = await writer.sendUpdate(docId, delta);
    expect(saved).toBe(true);

    // One dispatch: one doc_updates row, one allow audit row
    // (invariants 3 + 7 over the WS lane).
    expect(await docUpdatesCount()).toBe(rowsBefore + 1);
    expect(await applyUpdateAuditCount("allow")).toBe(auditBefore + 1);
    // Durable through the same read path HTTP callers use…
    expect(await docGetBody()).toContain("WS lane write");
    // …and broadcast live to the other attached client (post-commit).
    await watcher.waitForText(docId, "WS lane write");

    writer.close();
    watcher.close();
  });

  it("skips dispatch for a contained re-send — ack true, no new rows, no audit spam", async () => {
    const client = openClient();
    expect((await client.attach(docId)).outcome).toBe("authenticated");
    client.startSync(docId);
    await client.waitForText(docId, "WS lane write");

    const rowsBefore = await docUpdatesCount();
    const auditBefore = await applyUpdateAuditCount("allow");

    // Re-send the full known state — handshake-style chatter: the
    // preflight classifies it contained and never dispatches.
    const contained = Y.encodeStateAsUpdate(replicaOf(client));
    const saved = await client.sendUpdate(docId, contained);
    expect(saved).toBe(true);

    expect(await docUpdatesCount()).toBe(rowsBefore);
    expect(await applyUpdateAuditCount("allow")).toBe(auditBefore);
    client.close();
  });

  it("gates novel SyncStep2 payloads through the same dispatch lane", async () => {
    const client = openClient();
    expect((await client.attach(docId)).outcome).toBe("authenticated");
    client.startSync(docId);
    await client.waitForText(docId, "WS lane write");

    const rowsBefore = await docUpdatesCount();

    const replica = replicaOf(client);
    const before = Y.encodeStateVector(replica);
    replica.getXmlFragment(DOC_FRAGMENT).insert(1, [paragraphElement("Step2 lane write")]);
    const delta = Y.encodeStateAsUpdate(replica, before);

    const saved = await client.sendForAck(buildSyncStep2Frame(docId, delta));
    expect(saved).toBe(true);
    expect(await docUpdatesCount()).toBe(rowsBefore + 1);
    expect(await docGetBody()).toContain("Step2 lane write");
    client.close();
  });

  it("closes the connection on a refused delta (foreign shared type) and stages nothing", async () => {
    const client = openClient();
    expect((await client.attach(docId)).outcome).toBe("authenticated");

    const rowsBefore = await docUpdatesCount();
    const errorAuditBefore = await applyUpdateAuditCount("error");
    const bodyBefore = await docGetBody();

    // A delta that smuggles a NON-owned shared type next to the
    // fragment — `doc.apply_update` refuses it (`foreign_shared_type`)
    // and the gate turns the refusal into a per-doc close.
    const scratch = new Y.Doc();
    scratch.getMap("evil").set("k", "v");
    client.sendRaw(buildUpdateFrame(docId, Y.encodeStateAsUpdate(scratch)));
    await client.waitForDocClose(docId);

    // Nothing landed — and the refusal itself is on the audit trail
    // (outcome=error, the dispatcher's audited failure lane).
    expect(await docUpdatesCount()).toBe(rowsBefore);
    expect(await docGetBody()).toBe(bodyBefore);
    expect(await applyUpdateAuditCount("error")).toBe(errorAuditBefore + 1);
    client.close();
  });

  it("closes the trashed doc's room on doc.delete (revocation tap, per-document scope)", async () => {
    // Codex lift-gate MUST-FIX 3: a baseline reader's passive
    // subscription must not outlive the doc. The tap closes the ROOM
    // (per-document Close, socket survives), not user sockets — a
    // routine trash must not storm the workspace.
    const doomedId = await createDoc(activePort(), cookie, "Carol's doomed doc");
    const client = openClient();
    expect((await client.attach(doomedId)).outcome).toBe("authenticated");

    const res = await fetch(`http://127.0.0.1:${activePort()}/docs/delete/${doomedId}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    await client.waitForDocClose(doomedId);
    // Same socket, fresh Auth frame: the soft-deleted row denies.
    expect((await client.attach(doomedId)).outcome).toBe("denied");
    client.close();
  });
});

describe("operator read-only pin (collabReadOnly: true)", () => {
  let booted: BootedApp | undefined;
  let running: RunningServer | undefined;
  let cookie = "";
  let docId = "";

  function activePort(): number {
    if (running === undefined) throw new Error("server not started");
    return running.port;
  }

  async function docUpdatesCount(): Promise<number> {
    if (booted === undefined) throw new Error("not booted");
    const rows = await booted.driver
      .system()
      .selectFrom("doc_updates")
      .where("doc_id", "=", DocId(docId))
      .select("id")
      .execute();
    return rows.length;
  }

  async function docGetBody(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${activePort()}/docs/get/${docId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return res.text();
  }

  beforeAll(async () => {
    // The emergency knob: same production composition, posture pinned
    // read-only. Attaches still succeed; the gate never dispatches
    // (it only fires on non-readOnly connections) and every WS write
    // keeps the native nacked-not-applied contract.
    booted = await boot(true);
    const bootedNow = booted;
    running = await startServer(bootedNow, 0, [
      (server) => attachCollab(server, bootedNow, { publicOrigin: PUBLIC_ORIGIN }),
    ]);
    cookie = await signUp(running.port, "dave@example.com");
    docId = await createDoc(running.port, cookie, "Dave's pinned doc");
  });

  afterAll(async () => {
    await running?.close();
  });

  it("nacks a WS write and leaves durable + in-memory state untouched (pinned readOnly)", async () => {
    const client = new CollabClient(activePort(), { origin: PUBLIC_ORIGIN, cookie });
    const result = await client.attach(docId);
    expect(result.outcome).toBe("authenticated");
    expect(result.scope).toBe("readonly");

    const rowsBefore = await docUpdatesCount();
    const bodyBefore = await docGetBody();

    // A REAL Yjs update (not a malformed frame): a paragraph minted in
    // a scratch doc — exactly what a writing client would push.
    const scratch = new Y.Doc();
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("rogue WS write")]);
    scratch.getXmlFragment(DOC_FRAGMENT).insert(0, [para]);
    const saved = await client.sendUpdate(docId, Y.encodeStateAsUpdate(scratch));

    // Assert STATE, not just the denial frame (Codex review SHOULD-FIX).
    expect(saved).toBe(false);
    expect(await docUpdatesCount()).toBe(rowsBefore);
    expect(await docGetBody()).toBe(bodyBefore);
    client.close();
  });
});
