import { COLLAB_REVOKED_CLOSE_CODE, COLLAB_REVOKED_REASON } from "@editorzero/constants";
import { describe, expect, it } from "vitest";

import {
  type CollabEvent,
  type CollabPhase,
  collabNoticeMessage,
  collabPhaseReducer,
  collabWsUrl,
  isTerminalPhase,
} from "./collab";

/** Fold a fresh session through a sequence of provider events. */
function run(events: readonly CollabEvent[], from: CollabPhase = { kind: "connecting" }) {
  return events.reduce(collabPhaseReducer, from);
}

const SYNCED: CollabEvent = { kind: "synced" };
const AUTH_RW: CollabEvent = { kind: "authenticated", scope: "read-write" };

describe("collabPhaseReducer", () => {
  it("happy path: authenticated read-write then synced goes live", () => {
    expect(run([AUTH_RW, SYNCED])).toEqual({ kind: "live" });
  });

  it("authenticated alone is not live — the sync handshake completes it", () => {
    expect(run([AUTH_RW])).toEqual({ kind: "connecting" });
  });

  it("readonly scope (the operator pin, ADR 0043) degrades to the HTTP editor from any phase", () => {
    const pin: CollabEvent = { kind: "authenticated", scope: "readonly" };
    expect(run([pin])).toEqual({ kind: "fallback", why: "readonly_pin" });
    // Mid-session pin flip arrives on a reconnect's re-auth.
    expect(run([AUTH_RW, SYNCED, pin])).toEqual({ kind: "fallback", why: "readonly_pin" });
  });

  it("a pre-sync transport close is decisive: fall back, don't retry-limbo", () => {
    expect(run([{ kind: "closed", code: 1006, reason: "" }])).toEqual({
      kind: "fallback",
      why: "ws_unreachable",
    });
  });

  it("a post-sync transport close pauses (the provider's backoff reconnects)", () => {
    const phase = run([AUTH_RW, SYNCED, { kind: "closed", code: 1006, reason: "" }]);
    expect(phase).toEqual({ kind: "paused" });
    // The reconnect handshake re-syncs back to live.
    expect(run([SYNCED], phase)).toEqual({ kind: "live" });
  });

  it("disconnected status pauses a live canvas (ADR 0039: offline is read-only)", () => {
    const phase = run([AUTH_RW, SYNCED, { kind: "status", status: "disconnected" }]);
    expect(phase).toEqual({ kind: "paused" });
    // Connected alone does not resume editing — sync does.
    expect(run([{ kind: "status", status: "connected" }], phase)).toEqual({ kind: "paused" });
  });

  it("4401 is terminal in every phase — re-auth, don't blind-retry (ADR 0043)", () => {
    const revoked: CollabEvent = {
      kind: "closed",
      code: COLLAB_REVOKED_CLOSE_CODE,
      reason: COLLAB_REVOKED_REASON,
    };
    expect(run([revoked])).toEqual({ kind: "session_revoked" });
    expect(run([AUTH_RW, SYNCED, revoked])).toEqual({ kind: "session_revoked" });
    expect(run([AUTH_RW, SYNCED, { kind: "closed", code: 1006, reason: "" }, revoked])).toEqual({
      kind: "session_revoked",
    });
  });

  it("a per-doc revocation close (code 1000 + the reason) is doc_closed/revoked", () => {
    // The 3.4.4 provider synthesizes code 1000 for multiplexed Close
    // frames; the reason string is the discriminant (room close on
    // doc.delete, the revocation tap's per-document arm).
    const phase = run([
      AUTH_RW,
      SYNCED,
      { kind: "closed", code: 1000, reason: COLLAB_REVOKED_REASON },
    ]);
    expect(phase).toEqual({ kind: "doc_closed", revoked: true });
  });

  it("a per-doc reset close (gate refusal / server exception) is doc_closed/reset", () => {
    const phase = run([
      AUTH_RW,
      SYNCED,
      { kind: "closed", code: 1000, reason: "Reset Connection" },
    ]);
    expect(phase).toEqual({ kind: "doc_closed", revoked: false });
  });

  it("pre-sync auth refusal degrades to the HTTP lane; post-sync it ends the feed", () => {
    expect(run([{ kind: "auth_failed" }])).toEqual({ kind: "fallback", why: "auth_refused" });
    expect(run([AUTH_RW, SYNCED, { kind: "auth_failed" }])).toEqual({
      kind: "doc_closed",
      revoked: true,
    });
  });

  it("terminal phases absorb every late event (the destroy's own close echo)", () => {
    const terminal = run([{ kind: "authenticated", scope: "readonly" }]);
    expect(run([SYNCED, AUTH_RW, { kind: "closed", code: 1006, reason: "" }], terminal)).toEqual(
      terminal,
    );
  });
});

describe("isTerminalPhase", () => {
  it("classifies exactly the destroy-the-provider phases", () => {
    expect(isTerminalPhase({ kind: "connecting" })).toBe(false);
    expect(isTerminalPhase({ kind: "live" })).toBe(false);
    expect(isTerminalPhase({ kind: "paused" })).toBe(false);
    expect(isTerminalPhase({ kind: "fallback", why: "ws_unreachable" })).toBe(true);
    expect(isTerminalPhase({ kind: "session_revoked" })).toBe(true);
    expect(isTerminalPhase({ kind: "doc_closed", revoked: true })).toBe(true);
  });
});

describe("collabWsUrl", () => {
  it("derives the same-origin /collab endpoint for both schemes", () => {
    expect(collabWsUrl("http://localhost:5173")).toBe("ws://localhost:5173/collab");
    expect(collabWsUrl("https://docs.example.com")).toBe("wss://docs.example.com/collab");
  });
});

describe("collabNoticeMessage", () => {
  it("speaks only for the terminal notices", () => {
    expect(collabNoticeMessage({ kind: "live" })).toBeNull();
    expect(collabNoticeMessage({ kind: "connecting" })).toBeNull();
    expect(collabNoticeMessage({ kind: "session_revoked" })).toMatch(/sign in/i);
    expect(collabNoticeMessage({ kind: "doc_closed", revoked: true })).toMatch(/trash|revoked/i);
    expect(collabNoticeMessage({ kind: "doc_closed", revoked: false })).toMatch(/reset/i);
  });
});
