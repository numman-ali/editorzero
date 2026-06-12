/**
 * Socket registry pins (ADR 0043 Decision 5): targeted closes by user
 * and by session, idempotent release, and resilience to sockets that
 * throw mid-teardown — the properties the revocation tap leans on.
 */

import { SessionId, UserId } from "@editorzero/ids";
import { describe, expect, it } from "vitest";

import {
  COLLAB_REVOKED_CLOSE_CODE,
  type CollabSocketLike,
  createCollabSocketRegistry,
} from "./collabSockets";

const ALICE = UserId("018f0000-0000-7000-8000-000000000001");
const BOB = UserId("018f0000-0000-7000-8000-000000000002");
const SESSION_A = SessionId("018f0000-0000-7000-8000-00000000a001");
const SESSION_B = SessionId("018f0000-0000-7000-8000-00000000b002");

interface RecordingSocket extends CollabSocketLike {
  readonly closes: Array<{ code?: number; reason?: string }>;
}

function socket(): RecordingSocket {
  const closes: Array<{ code?: number; reason?: string }> = [];
  return {
    closes,
    close(code?: number, reason?: string) {
      closes.push(
        ...(code === undefined ? [{}] : [{ code, ...(reason !== undefined && { reason }) }]),
      );
    },
  };
}

describe("createCollabSocketRegistry", () => {
  it("closes a user's sockets with the revocation code and leaves others attached", () => {
    const registry = createCollabSocketRegistry();
    const aliceSocket = socket();
    const aliceSecond = socket();
    const bobSocket = socket();
    registry.register({ user_id: ALICE, session_id: SESSION_A, socket: aliceSocket });
    registry.register({ user_id: ALICE, session_id: SESSION_A, socket: aliceSecond });
    registry.register({ user_id: BOB, session_id: SESSION_B, socket: bobSocket });

    expect(registry.size()).toBe(3);
    expect(registry.closeByUser(ALICE)).toBe(2);
    expect(registry.size()).toBe(1);
    expect(aliceSocket.closes).toEqual([
      { code: COLLAB_REVOKED_CLOSE_CODE, reason: "authorization revoked" },
    ]);
    expect(aliceSecond.closes).toHaveLength(1);
    expect(bobSocket.closes).toHaveLength(0);
  });

  it("closes by session without touching the user's other sessions", () => {
    const registry = createCollabSocketRegistry();
    const phone = socket();
    const laptop = socket();
    registry.register({ user_id: ALICE, session_id: SESSION_A, socket: phone });
    registry.register({ user_id: ALICE, session_id: SESSION_B, socket: laptop });

    expect(registry.closeBySession(SESSION_A)).toBe(1);
    expect(phone.closes).toHaveLength(1);
    expect(laptop.closes).toHaveLength(0);
    expect(registry.size()).toBe(1);
  });

  it("never matches a null session_id on session-targeted closes", () => {
    const registry = createCollabSocketRegistry();
    const tokenish = socket();
    registry.register({ user_id: ALICE, session_id: null, socket: tokenish });
    expect(registry.closeBySession(SESSION_A)).toBe(0);
    expect(tokenish.closes).toHaveLength(0);
  });

  it("release is idempotent and a released socket is never closed", () => {
    const registry = createCollabSocketRegistry();
    const gone = socket();
    const release = registry.register({ user_id: ALICE, session_id: SESSION_A, socket: gone });
    release();
    release();
    expect(registry.size()).toBe(0);
    expect(registry.closeByUser(ALICE)).toBe(0);
    expect(gone.closes).toHaveLength(0);
  });

  it("survives a socket that throws on close — the sweep still completes", () => {
    const registry = createCollabSocketRegistry();
    const hostile: CollabSocketLike = {
      close() {
        throw new Error("already terminated");
      },
    };
    const wellBehaved = socket();
    registry.register({ user_id: ALICE, session_id: SESSION_A, socket: hostile });
    registry.register({ user_id: ALICE, session_id: SESSION_A, socket: wellBehaved });

    expect(registry.closeByUser(ALICE)).toBe(2);
    expect(wellBehaved.closes).toHaveLength(1);
    expect(registry.size()).toBe(0);
  });
});
