/**
 * Collab socket registry (ADR 0043 Decision 5 — the readOnly-lift
 * gate).
 *
 * Per-frame principal re-resolution protects the next WRITE; it does
 * nothing for a passive attached socket that keeps RECEIVING
 * broadcasts after its grant/session/membership is revoked — a real
 * read leak once writable production sockets exist. This registry is
 * the close half of the fix: `attachCollab` (apps/server) registers
 * every upgraded collab socket under the identity captured AT UPGRADE
 * (`{user_id, session_id}` — the adapter layer owns the upgrade;
 * Hocuspocus connection context deliberately stays identity-free), and
 * the composition root's revocation tap closes the affected subject's
 * sockets when standing changes. A surviving legitimate client
 * reconnects and re-runs `collabAuthorize`, which is the authority.
 *
 * Granularity is deliberately blunt (the ADR's words: "closing a
 * subject's sockets outright is correct today — re-attach is cheap and
 * re-auth is the authority"). Per-doc targeting refines later;
 * cross-process fan-out (more than one trunk) is a named revisit
 * trigger and lands on the §12 jobs runner.
 *
 * The socket surface is structural (`close(code?, reason?)`) so this
 * package stays free of the `ws` dependency; apps/server passes the
 * real WebSocket. Close code 4401 is the app-range "authorization
 * revoked" signal — distinguishable client-side from transport hiccups
 * (the future SPA provider treats it as "re-auth, don't blind-retry").
 */

import type { SessionId, UserId } from "@editorzero/ids";
import { COLLAB_REVOKED_CLOSE_CODE } from "@editorzero/sync";

/**
 * Re-exported from `@editorzero/sync` (the protocol layer owns the
 * close-code vocabulary — `closeDocumentConnections` sends the same
 * code at per-document scope).
 */
export { COLLAB_REVOKED_CLOSE_CODE };

export interface CollabSocketLike {
  close(code?: number, reason?: string): void;
}

export interface CollabSocketEntry {
  readonly user_id: UserId;
  /**
   * Session identity captured at upgrade — null is structurally
   * possible on `UserPrincipal` (token-borne principals) but the
   * cookie upgrade lane always carries one; a null entry simply never
   * matches a session-targeted close.
   */
  readonly session_id: SessionId | null;
  readonly socket: CollabSocketLike;
}

export interface CollabSocketRegistry {
  /**
   * Track an upgraded socket. Returns the release callback — idempotent,
   * wired to the socket's own `close` event by the caller so entries
   * never outlive their sockets.
   */
  register(entry: CollabSocketEntry): () => void;
  /** Close every socket the subject holds. Returns the count closed. */
  closeByUser(user_id: UserId): number;
  /** Close every socket riding the session. Returns the count closed. */
  closeBySession(session_id: SessionId): number;
  /** Live entry count (observability + tests). */
  size(): number;
}

export function createCollabSocketRegistry(): CollabSocketRegistry {
  const entries = new Set<CollabSocketEntry>();

  function closeWhere(match: (entry: CollabSocketEntry) => boolean): number {
    let closed = 0;
    for (const entry of entries) {
      if (!match(entry)) continue;
      entries.delete(entry);
      closed += 1;
      try {
        entry.socket.close(COLLAB_REVOKED_CLOSE_CODE, "authorization revoked");
      } catch {
        // A socket racing its own teardown can throw on close; the
        // entry is already deregistered and the transport is dying —
        // nothing to recover.
      }
    }
    return closed;
  }

  return {
    register(entry) {
      entries.add(entry);
      return () => {
        entries.delete(entry);
      };
    },
    closeByUser(user_id) {
      return closeWhere((entry) => entry.user_id === user_id);
    },
    closeBySession(session_id) {
      return closeWhere((entry) => entry.session_id === session_id);
    },
    size() {
      return entries.size;
    },
  };
}
