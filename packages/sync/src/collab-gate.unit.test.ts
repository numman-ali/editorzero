/**
 * Protocol-closure matrix for the WS write gate (ADR 0043 Decision 3,
 * review SHOULD-FIX 1).
 *
 * "Shape B's invariant rests on total classification of update-bearing
 * frames" — these tests pin that classification over every message
 * type a client can put on the wire, the gate's four lanes (pass /
 * readOnly pass-through / contained skip / novel dispatch), the
 * per-connection ordering chain, and the fail-closed defaults. The
 * version-pin test at the bottom fails the suite on any
 * `@hocuspocus/server` bump so the classification gets re-verified
 * against the new source BEFORE runtime sees it (the wire constants
 * and hook mechanics here were verified against the 3.4.4 source).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { MessageType } from "@hocuspocus/server";
import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";

import {
  type CollabApplyUpdatePayload,
  type CollabGatePayload,
  classifyWsFrame,
  createCollabWriteGate,
} from "./collab-gate";
import { base64ToBytes } from "./foreign-update";

const DOC_NAME = "0197d1e6-0000-7000-8000-000000000001";

/** Envelope + optional body, exactly as a Hocuspocus client encodes it. */
function frame(
  type: number,
  body?: (encoder: ReturnType<typeof createEncoder>) => void,
): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, DOC_NAME);
  writeVarUint(encoder, type);
  body?.(encoder);
  return toUint8Array(encoder);
}

function syncFrame(envelope: number, sub: number, payload: Uint8Array): Uint8Array {
  return frame(envelope, (encoder) => {
    writeVarUint(encoder, sub);
    writeVarUint8Array(encoder, payload);
  });
}

/** A real one-paragraph Yjs update minted in a scratch doc. */
function novelUpdate(text: string): Uint8Array {
  const scratch = new Y.Doc();
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText(text)]);
  scratch.getXmlFragment("document-store").insert(0, [para]);
  return Y.encodeStateAsUpdate(scratch);
}

interface GatePayloadOptions {
  readonly raw: Uint8Array;
  readonly connection?: { readonly readOnly: boolean };
  readonly document?: Y.Doc;
  readonly requestHeaders?: CollabGatePayload["requestHeaders"];
}

function gatePayload(options: GatePayloadOptions): CollabGatePayload {
  return {
    documentName: DOC_NAME,
    requestHeaders: options.requestHeaders ?? { cookie: "session=abc" },
    update: options.raw,
    connection: options.connection ?? { readOnly: false },
    document: options.document ?? new Y.Doc(),
  };
}

describe("classifyWsFrame — total classification", () => {
  it("passes SyncStep1 under both Sync and SyncReply envelopes (no dispatch)", () => {
    const sv = new Uint8Array([0]);
    expect(classifyWsFrame(syncFrame(MessageType.Sync, messageYjsSyncStep1, sv))).toEqual({
      kind: "pass",
      frame: "sync-step1",
    });
    expect(classifyWsFrame(syncFrame(MessageType.SyncReply, messageYjsSyncStep1, sv))).toEqual({
      kind: "pass",
      frame: "sync-step1",
    });
  });

  it("extracts the exact payload from SyncStep2 and Update frames", () => {
    const update = novelUpdate("hello");
    const step2 = classifyWsFrame(syncFrame(MessageType.Sync, messageYjsSyncStep2, update));
    expect(step2.kind).toBe("update");
    if (step2.kind !== "update") throw new Error("unreachable");
    expect(step2.frame).toBe("sync-step2");
    expect(Array.from(step2.update)).toEqual(Array.from(update));

    const yUpdate = classifyWsFrame(syncFrame(MessageType.Sync, messageYjsUpdate, update));
    expect(yUpdate.kind).toBe("update");
    if (yUpdate.kind !== "update") throw new Error("unreachable");
    expect(yUpdate.frame).toBe("sync-update");
    expect(Array.from(yUpdate.update)).toEqual(Array.from(update));
  });

  it("classifies a SyncReply-enveloped Update like a Sync one (native routes both)", () => {
    const update = novelUpdate("reply");
    const classified = classifyWsFrame(syncFrame(MessageType.SyncReply, messageYjsUpdate, update));
    expect(classified.kind).toBe("update");
  });

  it("refuses an unknown sync subtype", () => {
    const classified = classifyWsFrame(syncFrame(MessageType.Sync, 3, new Uint8Array([0])));
    expect(classified).toMatchObject({ kind: "refuse", frame: "sync-3" });
  });

  it("passes Awareness, Auth, QueryAwareness, Stateless, and Close frames", () => {
    expect(
      classifyWsFrame(frame(MessageType.Awareness, (e) => writeVarUint8Array(e, new Uint8Array()))),
    ).toEqual({ kind: "pass", frame: "awareness" });
    expect(classifyWsFrame(frame(MessageType.Auth))).toEqual({ kind: "pass", frame: "auth" });
    expect(classifyWsFrame(frame(MessageType.QueryAwareness))).toEqual({
      kind: "pass",
      frame: "query-awareness",
    });
    expect(classifyWsFrame(frame(MessageType.Stateless, (e) => writeVarString(e, "ping")))).toEqual(
      { kind: "pass", frame: "stateless" },
    );
    expect(classifyWsFrame(frame(MessageType.CLOSE))).toEqual({ kind: "pass", frame: "close" });
  });

  it("refuses BroadcastStateless (the unaudited relay is shut)", () => {
    const classified = classifyWsFrame(
      frame(MessageType.BroadcastStateless, (e) => writeVarString(e, "relay me")),
    );
    expect(classified).toMatchObject({ kind: "refuse", frame: "broadcast-stateless" });
  });

  it("refuses server-to-client and unknown message types", () => {
    // SyncStatus is something the SERVER sends; a client sending it has
    // no native handler (console.error + ignore) — the gate closes it.
    expect(classifyWsFrame(frame(MessageType.SyncStatus, (e) => writeVarUint(e, 1)))).toMatchObject(
      { kind: "refuse", frame: "type-8" },
    );
    expect(classifyWsFrame(frame(42))).toMatchObject({ kind: "refuse", frame: "type-42" });
  });

  it("refuses malformed frames instead of throwing (total over garbage)", () => {
    expect(classifyWsFrame(new Uint8Array())).toMatchObject({ kind: "refuse", frame: "malformed" });
    // Truncated mid-envelope: a varstring length prefix with no body.
    expect(classifyWsFrame(new Uint8Array([5, 97]))).toMatchObject({
      kind: "refuse",
      frame: "malformed",
    });
    // Sync envelope with no subtype byte.
    expect(classifyWsFrame(frame(MessageType.Sync))).toMatchObject({
      kind: "refuse",
      frame: "malformed",
    });
    // Update whose length prefix overruns the buffer.
    const overrun = frame(MessageType.Sync, (e) => {
      writeVarUint(e, messageYjsUpdate);
      writeVarUint(e, 100);
      // ...but only two bytes follow.
      writeVarUint(e, 0);
      writeVarUint(e, 0);
    });
    expect(classifyWsFrame(overrun)).toMatchObject({ kind: "refuse", frame: "malformed" });
  });
});

describe("createCollabWriteGate — the four lanes", () => {
  it("resolves pass-class frames without consulting the policy", async () => {
    const policy = vi.fn(() => Promise.resolve());
    const gate = createCollabWriteGate({ collabApplyUpdate: policy });
    await gate(
      gatePayload({
        raw: frame(MessageType.Awareness, (e) => writeVarUint8Array(e, new Uint8Array())),
      }),
    );
    await gate(
      gatePayload({ raw: syncFrame(MessageType.Sync, messageYjsSyncStep1, new Uint8Array([0])) }),
    );
    expect(policy).not.toHaveBeenCalled();
  });

  it("passes update frames through untouched on a readOnly connection (native nack lane)", async () => {
    const policy = vi.fn(() => Promise.resolve());
    const gate = createCollabWriteGate({ collabApplyUpdate: policy });
    const raw = syncFrame(MessageType.Sync, messageYjsUpdate, novelUpdate("rogue"));
    await gate(gatePayload({ raw, connection: { readOnly: true } }));
    expect(policy).not.toHaveBeenCalled();
  });

  it("skips dispatch when the update is contained in the resident (preflight)", async () => {
    const policy = vi.fn(() => Promise.resolve());
    const gate = createCollabWriteGate({ collabApplyUpdate: policy });
    const resident = new Y.Doc();
    resident.getXmlFragment("document-store").insert(0, [new Y.XmlElement("paragraph")]);
    // The client re-sends the full state it already has — classic
    // handshake chatter.
    const contained = Y.encodeStateAsUpdate(resident);
    await gate(
      gatePayload({
        raw: syncFrame(MessageType.Sync, messageYjsSyncStep2, contained),
        document: resident,
      }),
    );
    expect(policy).not.toHaveBeenCalled();
  });

  it("dispatches a novel update with the doc name, upgrade headers, and exact base64 payload", async () => {
    const calls: CollabApplyUpdatePayload[] = [];
    const policy = vi.fn((payload: CollabApplyUpdatePayload) => {
      calls.push(payload);
      return Promise.resolve();
    });
    const gate = createCollabWriteGate({ collabApplyUpdate: policy });
    const headers = { cookie: "session=abc" };
    const update = novelUpdate("novel content");
    await gate(
      gatePayload({
        raw: syncFrame(MessageType.Sync, messageYjsUpdate, update),
        requestHeaders: headers,
      }),
    );
    expect(policy).toHaveBeenCalledTimes(1);
    const received = calls[0];
    if (received === undefined) throw new Error("policy not called");
    expect(received.documentName).toBe(DOC_NAME);
    // Pass-through, not a copy: the policy re-resolves identity from
    // the ORIGINAL upgrade headers.
    expect(received.requestHeaders).toBe(headers);
    expect(Array.from(base64ToBytes(received.update))).toEqual(Array.from(update));
  });

  it("dispatches novel SyncStep2 payloads too (both update-bearing subtypes gate)", async () => {
    const policy = vi.fn(() => Promise.resolve());
    const gate = createCollabWriteGate({ collabApplyUpdate: policy });
    await gate(
      gatePayload({ raw: syncFrame(MessageType.Sync, messageYjsSyncStep2, novelUpdate("step2")) }),
    );
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it("rejects when the policy refuses — the frame's error propagates", async () => {
    const refusal = new Error("doc.apply_update: schema_violation");
    const gate = createCollabWriteGate({ collabApplyUpdate: () => Promise.reject(refusal) });
    await expect(
      gate(gatePayload({ raw: syncFrame(MessageType.Sync, messageYjsUpdate, novelUpdate("bad")) })),
    ).rejects.toBe(refusal);
  });

  it("rejects novel writes when NO policy is configured (fail-closed default)", async () => {
    const gate = createCollabWriteGate({});
    await expect(
      gate(gatePayload({ raw: syncFrame(MessageType.Sync, messageYjsUpdate, novelUpdate("x")) })),
    ).rejects.toThrow(/no write policy configured/);
  });

  it("refuses BroadcastStateless even on a readOnly connection", async () => {
    const gate = createCollabWriteGate({});
    await expect(
      gate(
        gatePayload({
          raw: frame(MessageType.BroadcastStateless, (e) => writeVarString(e, "relay")),
          connection: { readOnly: true },
        }),
      ),
    ).rejects.toThrow(/broadcast-stateless/);
  });

  it("refuses unknown types and malformed frames through the gate", async () => {
    const gate = createCollabWriteGate({});
    await expect(gate(gatePayload({ raw: frame(42) }))).rejects.toThrow(/type-42/);
    await expect(gate(gatePayload({ raw: new Uint8Array([1]) }))).rejects.toThrow(/malformed/);
  });
});

describe("createCollabWriteGate — per-connection ordering", () => {
  it("serialises frames per connection: B's dispatch starts only after A's settles", async () => {
    const releases: Array<() => void> = [];
    const policy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const gate = createCollabWriteGate({ collabApplyUpdate: policy });
    const connection = { readOnly: false };
    const document = new Y.Doc();

    const settledA = gate(
      gatePayload({
        raw: syncFrame(MessageType.Sync, messageYjsUpdate, novelUpdate("A")),
        connection,
        document,
      }),
    );
    const settledB = gate(
      gatePayload({
        raw: syncFrame(MessageType.Sync, messageYjsUpdate, novelUpdate("B")),
        connection,
        document,
      }),
    );

    // Both frames have arrived; only A may be in flight.
    await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
    const releaseA = releases[0];
    if (releaseA === undefined) throw new Error("A never dispatched");
    releaseA();
    await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(2));
    const releaseB = releases[1];
    if (releaseB === undefined) throw new Error("B never dispatched");
    releaseB();
    await Promise.all([settledA, settledB]);
  });

  it("latches a refused connection: subsequent frames (even pass-class) reject", async () => {
    const refusal = new Error("permission_denied");
    const gate = createCollabWriteGate({ collabApplyUpdate: () => Promise.reject(refusal) });
    const connection = { readOnly: false };
    await expect(
      gate(
        gatePayload({
          raw: syncFrame(MessageType.Sync, messageYjsUpdate, novelUpdate("A")),
          connection,
        }),
      ),
    ).rejects.toBe(refusal);
    // The connection is condemned (Hocuspocus is already closing it);
    // a racing awareness frame must not sneak through the gate.
    await expect(
      gate(
        gatePayload({
          raw: frame(MessageType.Awareness, (e) => writeVarUint8Array(e, new Uint8Array())),
          connection,
        }),
      ),
    ).rejects.toBe(refusal);
  });

  it("keeps connections independent: one refusal does not poison another socket", async () => {
    const gate = createCollabWriteGate({ collabApplyUpdate: () => Promise.resolve() });
    const condemned = { readOnly: false };
    const healthy = { readOnly: false };
    await expect(gate(gatePayload({ raw: frame(42), connection: condemned }))).rejects.toThrow(
      /type-42/,
    );
    await expect(
      gate(
        gatePayload({
          raw: syncFrame(MessageType.Sync, messageYjsUpdate, novelUpdate("ok")),
          connection: healthy,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("version pin (ADR 0043 Decision 3)", () => {
  it("pins @hocuspocus/server to 3.4.4 — re-verify the gate's source contract on ANY bump", () => {
    /**
     * What this pin protects (all verified in the 3.4.4 source):
     *   - `Connection.handleMessage` awaits `beforeHandleMessage` with
     *     the RAW frame before `MessageReceiver.apply`, and a hook
     *     rejection closes that per-document connection.
     *   - The `MessageType` wire values asserted below.
     *   - readOnly lanes: SyncStep2 acks via `snapshotContainsUpdate`,
     *     Update nacks unconditionally; neither applies.
     *   - `openDirectConnection` constructs no `Connection`, so the
     *     hook can never fire for dispatcher writes (no re-entrancy).
     *   - Unknown inbound types are console.error'd + IGNORED natively
     *     (the gate is what turns them into closures).
     * On a bump: re-read Connection.ts / MessageReceiver.ts /
     * ClientConnection.ts, update the gate + this docstring, then move
     * this pin.
     */
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("@hocuspocus/server");
    const pkgRaw = readFileSync(join(dirname(resolved), "..", "package.json"), "utf8");
    const pkg: unknown = JSON.parse(pkgRaw);
    const version =
      typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : undefined;
    expect(version).toBe("3.4.4");
  });

  it("pins the wire constants the classifier switches on", () => {
    expect(MessageType.Sync).toBe(0);
    expect(MessageType.Awareness).toBe(1);
    expect(MessageType.Auth).toBe(2);
    expect(MessageType.QueryAwareness).toBe(3);
    expect(MessageType.SyncReply).toBe(4);
    expect(MessageType.Stateless).toBe(5);
    expect(MessageType.BroadcastStateless).toBe(6);
    expect(MessageType.CLOSE).toBe(7);
    expect(MessageType.SyncStatus).toBe(8);
    expect(messageYjsSyncStep1).toBe(0);
    expect(messageYjsSyncStep2).toBe(1);
    expect(messageYjsUpdate).toBe(2);
  });
});
