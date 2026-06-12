/**
 * `HocuspocusSync` WebSocket attach — the sync-layer half of the ADR
 * 0030 hardening (task #15), against real SQLite + real WebSockets.
 * The production upgrade boundary (path / Origin / cookie) lives in
 * apps/server and is tested there; HERE the contract is the class
 * itself:
 *
 *   1. **Deny-all by construction** — a `HocuspocusSync` built without
 *      a `collabAuthorize` policy refuses every WS attach. This is the
 *      red-team blocker inverted: Hocuspocus treats a hook-less server
 *      as needing no auth at all, so the class always registers
 *      `onAuthenticate` and the DEFAULT policy is refusal.
 *   2. **Forced readOnly** — when a policy allows, the Authenticated
 *      frame still carries scope `"readonly"` (invariant 3: no audited
 *      WS write lane yet — no policy outcome can grant write).
 *   3. **`__ws` hydration** — a WS client attaching to a COLD doc gets
 *      committed `doc_updates` state replayed before sync (proven
 *      across two instances over one SQLite file — the restart shape).
 *   4. **Policy payload contract** — `collabAuthorize` receives the
 *      multiplexed `documentName` and the ORIGINAL upgrade request
 *      headers (what the composition root re-resolves the principal
 *      from, per Auth frame).
 *   5. **Rollback eviction with live WS clients** — the Codex-review
 *      MUST-FIX: `closeConnections` alone is not eviction. Rollback
 *      force-closes the doc's WS clients AND awaits the unload drain,
 *      so the next transact/read rehydrates committed state — never
 *      the aborted in-memory mutation.
 *   6. **Poisoned fail-closed + recovery** — if eviction cannot be
 *      proven (here: an extra DirectConnection holder that
 *      `closeConnections` cannot kill), both open paths refuse loudly;
 *      once the holder releases, the retry path clears and serves
 *      committed state.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  asAuditTx,
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createSqliteDriver,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { DocId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { readAuthMessage, writeAuthentication } from "@hocuspocus/common";
import { MessageType } from "@hocuspocus/server";
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";

import { DOC_FRAGMENT, seedBlocks } from "./blocks";
import {
  type CollabAuthorizePayload,
  HocuspocusSync,
  type HocuspocusSyncDeps,
  type HocuspocusTxContext,
} from "./hocuspocus";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_ID = DocId("018f0000-0000-7000-8000-0000000000d1");
const BLOCK_ID = "018f0000-0000-7000-8000-0000000000b1";
const WS_TIMEOUT_MS = 3000;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

let driver: SqliteDriver;
/** Everything `close()`-able the test minted, torn down in reverse. */
let cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
  cleanups = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  await driver.close();
});

function buildSync(extra: Partial<HocuspocusSyncDeps> = {}): HocuspocusSync {
  const sync = new HocuspocusSync({
    docUpdatesWriter: createDocUpdatesWriter(),
    docUpdatesReader: createDocUpdatesReader(),
    systemDb: driver.system(),
    ...extra,
  });
  cleanups.push(() => sync.close());
  return sync;
}

/** Bare WS host: every upgrade goes straight to `sync.handleWsConnection`. */
async function listenFor(sync: HocuspocusSync): Promise<number> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      sync.handleWsConnection(client, req);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address !== "object") throw new Error("no bound port");
  return address.port;
}

function testPrincipal(): UserPrincipal {
  return {
    kind: "user",
    id: USER_ID,
    workspace_id: WORKSPACE_ID,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

async function seedDocMetadata(doc_id: DocId): Promise<void> {
  const now = Date.now();
  await driver
    .system()
    .insertInto("docs")
    .values({
      id: doc_id,
      workspace_id: WORKSPACE_ID,
      collection_id: null,
      title: "test",
      slug: doc_id,
      order_key: doc_id,
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
      created_by: USER_ID,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    .execute();
}

/** Commit one block of `content` to `doc_id` through the audited lane. */
async function commitContent(sync: HocuspocusSync, doc_id: DocId, content: string): Promise<void> {
  await driver.withSystemTx(async (tx) => {
    const ctx: HocuspocusTxContext = {
      sqlTx: asAuditTx(tx),
      principal: testPrincipal(),
      workspace_id: WORKSPACE_ID,
    };
    await sync.bind(ctx).transact(doc_id, (ydoc) => {
      seedBlocks(ydoc, [{ id: BLOCK_ID, type: "paragraph", content }]);
    });
  });
}

function rawToUint8(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

type AuthOutcome = "authenticated" | "denied" | "rejected";

interface AuthResult {
  readonly outcome: AuthOutcome;
  readonly scope: string | null;
}

/**
 * Minimal Hocuspocus protocol client (the cohost suite carries a richer
 * sibling — duplicated rather than shared: test helpers don't cross
 * package boundaries, and each suite pins only the frames it needs).
 */
class WsClient {
  readonly #ws: WebSocket;
  readonly #open: Promise<void>;
  /**
   * Resolves when the server sends a per-document Close frame
   * (`MessageType.CLOSE`) — what Hocuspocus's `Connection.close`
   * actually emits on a multiplexed socket: the doc subscription dies,
   * the raw WebSocket survives for other documents. Eviction tests
   * await THIS, not a socket close.
   */
  readonly docClosed: Promise<void>;
  #settleDocClosed: (() => void) | undefined;
  readonly local = new Y.Doc();
  #pendingAuth: ((result: AuthResult) => void) | null = null;

  constructor(
    port: number,
    private readonly documentName: string,
  ) {
    this.#ws = new WebSocket(`ws://127.0.0.1:${port}/collab`);
    this.#open = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timed out")), WS_TIMEOUT_MS);
      this.#ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#ws.on("error", () => {
        clearTimeout(timer);
        reject(new Error("ws rejected"));
      });
    });
    this.docClosed = new Promise((resolve) => {
      this.#settleDocClosed = resolve;
    });
    this.#ws.on("close", () => {
      this.#pendingAuth?.({ outcome: "rejected", scope: null });
      this.#pendingAuth = null;
      this.#settleDocClosed?.();
    });
    this.#ws.on("message", (data) => this.#onMessage(rawToUint8(data)));
  }

  #onMessage(frame: Uint8Array): void {
    const decoder = createDecoder(frame);
    readVarString(decoder); // documentName — single-doc clients here
    const type = readVarUint(decoder);
    if (type === MessageType.CLOSE) {
      this.#settleDocClosed?.();
      return;
    }
    if (type === MessageType.Auth) {
      let result: AuthResult | null = null;
      readAuthMessage(
        decoder,
        () => {
          /* token prompt — non-terminal */
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
        Y.applyUpdate(this.local, readVarUint8Array(decoder));
      }
    }
  }

  async attach(): Promise<AuthResult> {
    await this.#open.catch(() => {
      /* rejected upgrades settle as "rejected" below */
    });
    if (this.#ws.readyState !== WebSocket.OPEN) return { outcome: "rejected", scope: null };
    return new Promise<AuthResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("auth timed out")), WS_TIMEOUT_MS);
      this.#pendingAuth = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      const encoder = createEncoder();
      writeVarString(encoder, this.documentName);
      writeVarUint(encoder, MessageType.Auth);
      writeAuthentication(encoder, "test-token");
      this.#ws.send(toUint8Array(encoder));
    });
  }

  /** SyncStep1 with an empty state vector — pull full server state. */
  requestSync(): void {
    const encoder = createEncoder();
    writeVarString(encoder, this.documentName);
    writeVarUint(encoder, MessageType.Sync);
    writeVarUint(encoder, SYNC_STEP1);
    writeVarUint8Array(encoder, new Uint8Array([0]));
    this.#ws.send(toUint8Array(encoder));
  }

  async waitForText(needle: string): Promise<void> {
    const deadline = Date.now() + WS_TIMEOUT_MS;
    for (;;) {
      if (this.local.getXmlFragment(DOC_FRAGMENT).toString().includes(needle)) return;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for "${needle}" in: ${this.local.getXmlFragment(DOC_FRAGMENT).toString()}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  close(): void {
    this.#ws.close();
  }
}

describe("collabAuthorize by construction", () => {
  it("refuses every WS attach when no policy was configured (deny-all default)", async () => {
    const sync = buildSync(); // no collabAuthorize
    await seedDocMetadata(DOC_ID);
    const port = await listenFor(sync);

    const client = new WsClient(port, DOC_ID);
    expect((await client.attach()).outcome).toBe("denied");
    client.close();
  });

  it("forces scope readonly even when the policy allows (invariant 3)", async () => {
    const sync = buildSync({ collabAuthorize: () => Promise.resolve() });
    await seedDocMetadata(DOC_ID);
    const port = await listenFor(sync);

    const client = new WsClient(port, DOC_ID);
    const result = await client.attach();
    expect(result.outcome).toBe("authenticated");
    expect(result.scope).toBe("readonly");
    client.close();
  });

  it("hands the policy the documentName and the upgrade request headers", async () => {
    const seen: CollabAuthorizePayload[] = [];
    const sync = buildSync({
      collabAuthorize: (payload) => {
        seen.push(payload);
        return Promise.resolve();
      },
    });
    await seedDocMetadata(DOC_ID);
    const port = await listenFor(sync);

    // A second doc on the SAME socket would re-invoke the policy — the
    // per-Auth-frame contract — but one doc suffices to pin the payload
    // shape the composition root re-resolves principals from.
    const client = new WsClient(port, DOC_ID);
    expect((await client.attach()).outcome).toBe("authenticated");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.documentName).toBe(DOC_ID);
    // ws sends the Host header on every upgrade; its presence proves
    // these are the ORIGINAL request headers, not a synthetic object.
    expect(seen[0]?.requestHeaders.host).toContain("127.0.0.1");
    client.close();
  });

  it("closes the socket instead of attaching after close()", async () => {
    const sync = buildSync({ collabAuthorize: () => Promise.resolve() });
    const port = await listenFor(sync);
    await sync.close();

    const client = new WsClient(port, DOC_ID);
    expect((await client.attach()).outcome).toBe("rejected");
  });
});

describe("__ws hydration", () => {
  it("replays committed doc_updates to a cold attach (across instances — the restart shape)", async () => {
    await seedDocMetadata(DOC_ID);
    const writer = buildSync({ collabAuthorize: () => Promise.resolve() });
    await commitContent(writer, DOC_ID, "durable before attach");
    await writer.close();

    // A fresh instance over the same SQLite: the doc is COLD here, so
    // the attach exercises the `__ws` onLoadDocument branch, not warm
    // residency.
    const reader = buildSync({ collabAuthorize: () => Promise.resolve() });
    const port = await listenFor(reader);
    const client = new WsClient(port, DOC_ID);
    expect((await client.attach()).outcome).toBe("authenticated");
    client.requestSync();
    await client.waitForText("durable before attach");
    client.close();
  });
});

describe("rollback eviction with WS clients attached", () => {
  it("evicts the aborted in-memory state and rehydrates committed state (Codex MUST-FIX)", async () => {
    await seedDocMetadata(DOC_ID);
    const sync = buildSync({ collabAuthorize: () => Promise.resolve() });
    await commitContent(sync, DOC_ID, "committed");

    const port = await listenFor(sync);
    const client = new WsClient(port, DOC_ID);
    expect((await client.attach()).outcome).toBe("authenticated");

    // A dispatcher-shaped failing write: mutate inside the bound
    // transact, abort the SQL tx, then rollback() — exactly what
    // runInWriteTx's catch path does.
    let bound: ReturnType<HocuspocusSync["bind"]> | undefined;
    await expect(
      driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        bound = sync.bind(ctx);
        await bound.transact(DOC_ID, (ydoc) => {
          const para = new Y.XmlElement("paragraph");
          para.insert(0, [new Y.XmlText("phantom")]);
          ydoc.getXmlFragment(DOC_FRAGMENT).insert(0, [para]);
        });
        throw new Error("dispatcher aborts");
      }),
    ).rejects.toThrow("dispatcher aborts");
    if (bound === undefined) throw new Error("bind never ran");
    await bound.rollback();

    // The WS client held the doc resident — eviction must have closed
    // its per-doc subscription (the Close frame) so the unload could
    // complete. The raw socket survives; a real provider would resync.
    await client.docClosed;

    // The proof: the next read AND the next transact see committed
    // state only. Pre-fix, both would have reused the resident Y.Doc
    // with "phantom" applied.
    const text = await sync.read(DOC_ID, (ydoc) => ydoc.getXmlFragment(DOC_FRAGMENT).toString());
    expect(text).toContain("committed");
    expect(text).not.toContain("phantom");

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      await sync.bind(ctx).transact(DOC_ID, (ydoc) => {
        expect(ydoc.getXmlFragment(DOC_FRAGMENT).toString()).not.toContain("phantom");
      });
    });
  });

  // The unevictable-holder / poisoned fail-closed path is pinned in
  // `hocuspocus.integration.test.ts` (the rollback-contract file) —
  // it needs no WebSocket, only a direct-connection squatter.
});
