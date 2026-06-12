import { COLLAB_REVOKED_CLOSE_CODE, COLLAB_REVOKED_REASON } from "@editorzero/constants";

/**
 * Collab session policy — the pure half of the `doc.apply_update × Web
 * UI` cell (the live editor). The provider/editor wiring lives in
 * `components/collab-doc-editor.tsx`; everything decidable without a
 * socket is here, unit-tested: the phase reducer, close-frame
 * classification (ADR 0043's close-code contract), and the WS URL
 * derivation.
 *
 * The phase machine encodes three ADR obligations:
 *
 *  - **ADR 0043 (re-auth, don't blind-retry).** A socket close with
 *    `COLLAB_REVOKED_CLOSE_CODE` (4401) is a REVOCATION — the session
 *    or standing ended server-side. The reducer goes terminal
 *    (`session_revoked`); the component destroys the provider so its
 *    built-in backoff can never retry a dead credential into a
 *    reconnect storm. Per-DOCUMENT closes have no code on the wire
 *    (the 3.4.4 provider synthesizes `code: 1000`), so doc-level
 *    revocation reads `COLLAB_REVOKED_REASON` instead; any other
 *    per-doc reason is Hocuspocus's generic reset (a refused write,
 *    a server exception) — also terminal, with a reload affordance.
 *
 *  - **ADR 0039 (offline is read-only).** Transport loss after a
 *    successful sync pauses the canvas (`paused` — non-editable)
 *    while the provider's own backoff reconnects. Local edits while
 *    disconnected would queue in the Y.Doc and replay on reconnect as
 *    an offline-write lane this product deliberately does not have.
 *
 *  - **The operator pin / degraded lane (ADR 0043 lift posture).**
 *    `authenticated` with scope `readonly` means the server pinned
 *    `collabReadOnly` — WS writes would be silently nacked, so the
 *    component falls back to the HTTP editor (`doc.update` + explicit
 *    Save still works in that posture). Same fallback when the WS
 *    can't establish at all: the FIRST pre-sync transport close is
 *    decisive (deterministic, no retry limbo behind a skeleton); the
 *    next doc navigation tries collab fresh.
 */

export type CollabScope = "read-write" | "readonly";
export type CollabStatus = "connecting" | "connected" | "disconnected";

/** Why the screen rendered the HTTP editor instead of the live canvas. */
export type FallbackWhy = "ws_unreachable" | "readonly_pin" | "auth_refused";

export type CollabPhase =
  /** Provider created; waiting for the first sync handshake. */
  | { readonly kind: "connecting" }
  /** Synced and connected — the canvas is editable. */
  | { readonly kind: "live" }
  /** Transport lost after sync — read-only canvas, auto-reconnect running. */
  | { readonly kind: "paused" }
  /** Terminal: render the HTTP editor (Save lane). */
  | { readonly kind: "fallback"; readonly why: FallbackWhy }
  /** Terminal: 4401 — the session was revoked; re-auth is the only way back. */
  | { readonly kind: "session_revoked" }
  /** Terminal: this doc's feed was closed server-side. */
  | { readonly kind: "doc_closed"; readonly revoked: boolean };

export type CollabEvent =
  | { readonly kind: "authenticated"; readonly scope: CollabScope }
  | { readonly kind: "auth_failed" }
  | { readonly kind: "synced" }
  | { readonly kind: "status"; readonly status: CollabStatus }
  | { readonly kind: "closed"; readonly code: number; readonly reason: string };

/** Terminal phases destroy the provider (no further events expected). */
export function isTerminalPhase(phase: CollabPhase): boolean {
  return (
    phase.kind === "fallback" || phase.kind === "session_revoked" || phase.kind === "doc_closed"
  );
}

/**
 * Per-doc Close frames arrive with a synthesized `code: 1000` and the
 * wire reason (see the module docstring); everything else on 1000/1005
 * is treated the same way — the server never closes sockets with a
 * normal code, so a "clean" close is always doc-scoped.
 */
function classifyClose(
  code: number,
  reason: string,
): "session_revoked" | "doc_revoked" | "doc_reset" | "transport" {
  if (code === COLLAB_REVOKED_CLOSE_CODE) return "session_revoked";
  if (code === 1000 || code === 1005) {
    return reason === COLLAB_REVOKED_REASON ? "doc_revoked" : "doc_reset";
  }
  return "transport";
}

export function collabPhaseReducer(phase: CollabPhase, event: CollabEvent): CollabPhase {
  // Terminal phases absorb everything — the provider is being torn
  // down and late events (its own close echo) must not resurrect it.
  if (isTerminalPhase(phase)) return phase;

  switch (event.kind) {
    case "authenticated":
      // The operator's readOnly pin: WS writes would be nacked, the
      // HTTP lane still saves — degrade to it in ANY phase.
      return event.scope === "readonly" ? { kind: "fallback", why: "readonly_pin" } : phase;
    case "auth_failed":
      // Pre-sync: the route loader's doc.get JUST succeeded, so read
      // standing exists and the HTTP lane (which re-checks everything)
      // is the honest degrade. Post-sync it means standing was lost
      // mid-session — that feed is over.
      return phase.kind === "connecting"
        ? { kind: "fallback", why: "auth_refused" }
        : { kind: "doc_closed", revoked: true };
    case "synced":
      return { kind: "live" };
    case "status":
      // Post-sync transport state drives editability (ADR 0039:
      // disconnected canvas is read-only). "connected" alone is not
      // "live" — sync completes the handshake.
      if (phase.kind === "live" && event.status !== "connected") return { kind: "paused" };
      return phase;
    case "closed": {
      const classified = classifyClose(event.code, event.reason);
      if (classified === "session_revoked") return { kind: "session_revoked" };
      if (classified === "doc_revoked") return { kind: "doc_closed", revoked: true };
      if (classified === "doc_reset") return { kind: "doc_closed", revoked: false };
      // Transport close: decisive pre-sync (fall back to the HTTP
      // editor rather than a retry limbo), recoverable post-sync (the
      // provider's own backoff is already reconnecting).
      return phase.kind === "connecting"
        ? { kind: "fallback", why: "ws_unreachable" }
        : { kind: "paused" };
    }
  }
}

/**
 * Same-origin collab WS endpoint (`/collab`, ADR 0027/0030 — the dev
 * proxy forwards it with `ws: true`, production co-hosts it on the
 * trunk). `origin` is `window.location.origin`.
 */
export function collabWsUrl(origin: string): string {
  return `${origin.replace(/^http/, "ws")}/collab`;
}

/** User-facing copy for the terminal notices. */
export function collabNoticeMessage(phase: CollabPhase): string | null {
  switch (phase.kind) {
    case "session_revoked":
      return "Your session ended. Sign in again to keep editing.";
    case "doc_closed":
      return phase.revoked
        ? "Access to this doc just changed — it may have been moved to trash or your access revoked."
        : "The live session was reset by the server.";
    default:
      return null;
  }
}
