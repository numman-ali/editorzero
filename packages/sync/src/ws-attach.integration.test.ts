/**
 * `HocuspocusSync` WebSocket attach — the sync-layer half of the ADR
 * 0030 hardening (task #15) + the ADR 0043 broadcast-after-commit
 * property pins, against real SQLite + real WebSockets. The production
 * upgrade boundary (path / Origin / cookie) lives in apps/server and
 * is tested there; HERE the contract is the class itself:
 *
 *   1. **Deny-all by construction** — a `HocuspocusSync` built without
 *      a `collabAuthorize` policy refuses every WS attach. This is the
 *      red-team blocker inverted: Hocuspocus treats a hook-less server
 *      as needing no auth at all, so the class always registers
 *      `onAuthenticate` and the DEFAULT policy is refusal.
 *   2. **Write posture is the operator's, not the policy's** — the
 *      Authenticated frame's scope comes from `collabReadOnly` alone
 *      (default lifted/`"read-write"` since ADR 0043 Decisions 3+5
 *      landed; `true` pins `"readonly"`). No attach-policy outcome can
 *      widen it.
 *   3. **`__ws` hydration** — a WS client attaching to a COLD doc gets
 *      committed `doc_updates` state replayed before sync (proven
 *      across two instances over one SQLite file — the restart shape).
 *   4. **Policy payload contract** — `collabAuthorize` receives the
 *      multiplexed `documentName` and the ORIGINAL upgrade request
 *      headers (what the composition root re-resolves the principal
 *      from, per Auth frame).
 *   5. **No broadcast without a commit (ADR 0043 / Codex M1)** — a
 *      handler that throws after a staged Y mutation, with WS clients
 *      attached, broadcasts NOTHING: the client's subscription
 *      survives (no eviction Close frame — the pre-0043 machinery is
 *      gone), the resident bit-equals a cold replay of committed
 *      `doc_updates`, and the next read/transact sees committed-only
 *      state.
 *   6. **Broadcast arrives at `commit()`** — a committed-but-not-yet-
 *      applied delta is invisible to attached AND freshly-syncing
 *      clients; `bound.commit()` is the exact moment it fans out.
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
import type { BoundSyncService } from "./service";

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

function bindCtx(tx: Parameters<typeof asAuditTx>[0]): HocuspocusTxContext {
  return {
    sqlTx: asAuditTx(tx),
    principal: testPrincipal(),
    workspace_id: WORKSPACE_ID,
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

/** Append one `<paragraph>text</paragraph>` to the owned fragment. */
function appendParagraph(ydoc: Y.Doc, text: string): void {
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText(text)]);
  const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
  fragment.insert(fragment.length, [para]);
}

/**
 * Dispatcher-shaped committed write: SQL tx + bind + transact, then
 * `bound.commit()` after the tx resolves — the broadcast moment. The
 * first write on a doc seeds a block; later writes append paragraphs
 * (`seedBlocks` is first-time-only by contract).
 */
async function commitContent(sync: HocuspocusSync, doc_id: DocId, content: string): Promise<void> {
  let bound: BoundSyncService | undefined;
  await driver.withSystemTx(async (tx) => {
    bound = sync.bind(bindCtx(tx));
    await bound.transact(doc_id, (ydoc) => {
      if (ydoc.getXmlFragment(DOC_FRAGMENT).length === 0) {
        seedBlocks(ydoc, [{ id: BLOCK_ID, type: "paragraph", content }]);
      } else {
        appendParagraph(ydoc, content);
      }
    });
  });
  await bound?.commit();
}

async function fetchDocUpdates(doc_id: DocId): Promise<Uint8Array[]> {
  const rows = await driver
    .system()
    .selectFrom("doc_updates")
    .select(["seq", "update_blob"])
    .where("doc_id", "=", doc_id)
    .orderBy("seq", "asc")
    .execute();
  return rows.map((r) => r.update_blob);
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
   * the raw WebSocket survives for other documents. The ADR 0043
   * tests use this NEGATIVELY: rollback must NOT close the doc
   * subscription (there is no eviction any more).
   */
  readonly docClosed: Promise<void>;
  #settleDocClosed: (() => void) | undefined;
  docClosedSeen = false;
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
      this.#settleDocClosed = () => {
        this.docClosedSeen = true;
        resolve();
      };
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

  fragmentText(): string {
    return this.local.getXmlFragment(DOC_FRAGMENT).toString();
  }

  async waitForText(needle: string): Promise<void> {
    const deadline = Date.now() + WS_TIMEOUT_MS;
    for (;;) {
      if (this.fragmentText().includes(needle)) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for "${needle}" in: ${this.fragmentText()}`);
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

  it("defaults to read-write scope (ADR 0043 lift) and the readOnly pin forces readonly", async () => {
    // The scope is decided by `collabReadOnly` alone — the attach
    // policy can admit or deny, never widen posture. Default = the
    // lifted ADR 0043 posture (writes flow through the audited gate);
    // `true` is the operator's emergency read-only pin.
    const lifted = buildSync({ collabAuthorize: () => Promise.resolve() });
    await seedDocMetadata(DOC_ID);
    const liftedPort = await listenFor(lifted);
    const liftedClient = new WsClient(liftedPort, DOC_ID);
    const liftedResult = await liftedClient.attach();
    expect(liftedResult.outcome).toBe("authenticated");
    expect(liftedResult.scope).toBe("read-write");
    liftedClient.close();

    const pinned = buildSync({
      collabAuthorize: () => Promise.resolve(),
      collabReadOnly: true,
    });
    const pinnedPort = await listenFor(pinned);
    const pinnedClient = new WsClient(pinnedPort, DOC_ID);
    const pinnedResult = await pinnedClient.attach();
    expect(pinnedResult.outcome).toBe("authenticated");
    expect(pinnedResult.scope).toBe("readonly");
    pinnedClient.close();
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

describe("broadcast-after-commit (ADR 0043)", () => {
  it("rollback after a staged mutation broadcasts nothing; the client's subscription survives; resident equals cold replay (Codex M1)", async () => {
    await seedDocMetadata(DOC_ID);
    const sync = buildSync({ collabAuthorize: () => Promise.resolve() });
    await commitContent(sync, DOC_ID, "committed");

    const port = await listenFor(sync);
    const client = new WsClient(port, DOC_ID);
    expect((await client.attach()).outcome).toBe("authenticated");
    client.requestSync();
    await client.waitForText("committed");

    // A dispatcher-shaped failing write: mutate inside the bound
    // transact, abort the SQL tx, then rollback() — exactly what
    // runInWriteTx's catch path does. The mutation only ever existed
    // on the throwaway clone; the resident was never touched, so
    // there is nothing to broadcast and nothing to evict.
    let bound: BoundSyncService | undefined;
    await expect(
      driver.withSystemTx(async (tx) => {
        bound = sync.bind(bindCtx(tx));
        await bound.transact(DOC_ID, (ydoc) => {
          appendParagraph(ydoc, "phantom");
        });
        throw new Error("dispatcher aborts");
      }),
    ).rejects.toThrow("dispatcher aborts");
    if (bound === undefined) throw new Error("bind never ran");
    await bound.rollback();

    // Positive control that doubles as the determinism bound: a real
    // committed write must reach the SAME subscription. Receiving it
    // proves (a) the doc subscription survived the rollback — no
    // eviction Close frame — and (b) any phantom broadcast would have
    // arrived first on this ordered socket, so its absence after this
    // point is conclusive, not a timing artifact.
    await commitContent(sync, DOC_ID, "after-rollback");
    await client.waitForText("after-rollback");
    expect(client.fragmentText()).not.toContain("phantom");
    expect(client.docClosedSeen).toBe(false);

    // The resident equals a cold replay of committed `doc_updates` —
    // same fragment text AND same state vector (a leaked phantom op
    // would register an extra client/clock entry even if the text
    // were later edited away).
    const blobs = await fetchDocUpdates(DOC_ID);
    expect(blobs).toHaveLength(2);
    const replay = new Y.Doc();
    for (const blob of blobs) Y.applyUpdate(replay, blob);
    const resident = await sync.read(DOC_ID, (ydoc) => ({
      text: ydoc.getXmlFragment(DOC_FRAGMENT).toString(),
      sv: Y.encodeStateVector(ydoc),
    }));
    expect(resident.text).toBe(replay.getXmlFragment(DOC_FRAGMENT).toString());
    expect(Array.from(resident.sv)).toEqual(Array.from(Y.encodeStateVector(replay)));
    expect(resident.text).not.toContain("phantom");

    // And the next transact's clone builds on committed-only state.
    await driver.withSystemTx(async (tx) => {
      const fresh = sync.bind(bindCtx(tx));
      await fresh.transact(DOC_ID, (ydoc) => {
        expect(ydoc.getXmlFragment(DOC_FRAGMENT).toString()).not.toContain("phantom");
      });
    });
    client.close();
  });

  it("a committed-but-unapplied delta is invisible until commit(), then broadcasts to every attached client", async () => {
    await seedDocMetadata(DOC_ID);
    const sync = buildSync({ collabAuthorize: () => Promise.resolve() });
    await commitContent(sync, DOC_ID, "base");

    const port = await listenFor(sync);
    const client1 = new WsClient(port, DOC_ID);
    expect((await client1.attach()).outcome).toBe("authenticated");
    client1.requestSync();
    await client1.waitForText("base");

    // Stage + SQL-commit a delta WITHOUT calling bound.commit() yet —
    // the window between `withSystemTx` resolving and the broadcast
    // moment, frozen open.
    let bound: BoundSyncService | undefined;
    await driver.withSystemTx(async (tx) => {
      bound = sync.bind(bindCtx(tx));
      await bound.transact(DOC_ID, (ydoc) => {
        appendParagraph(ydoc, "staged-delta");
      });
    });
    if (bound === undefined) throw new Error("bind never ran");

    // A SECOND client attaches and full-syncs inside the window. Its
    // SyncStep2 reply reflects the resident — which must still be
    // committed-only-as-applied: "base" arrives, "staged-delta" does
    // not. The completed round-trip is the deterministic barrier; at
    // this point client1 cannot hold the delta either (the resident
    // never applied it, so no frame carrying it exists anywhere).
    const client2 = new WsClient(port, DOC_ID);
    expect((await client2.attach()).outcome).toBe("authenticated");
    client2.requestSync();
    await client2.waitForText("base");
    expect(client2.fragmentText()).not.toContain("staged-delta");
    expect(client1.fragmentText()).not.toContain("staged-delta");

    // The broadcast moment: commit() applies the staged blob to the
    // resident, and Hocuspocus fans it out to BOTH attached clients
    // live — no resync, no reconnect.
    await bound.commit();
    await client1.waitForText("staged-delta");
    await client2.waitForText("staged-delta");

    client1.close();
    client2.close();
  });
});
