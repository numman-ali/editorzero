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
 * (a `user` key `{user_id, session_id}` on the cookie lane, an `agent`
 * key `{agent_id, token_id}` on the bearer lane — the adapter layer owns
 * the upgrade; Hocuspocus connection context deliberately stays
 * identity-free), and the composition root's revocation tap closes the
 * affected subject's sockets when standing changes. A surviving legitimate client
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

import { COLLAB_REVOKED_CLOSE_CODE, COLLAB_REVOKED_REASON } from "@editorzero/constants/collab";
import type { AgentId, SessionId, TokenId, UserId } from "@editorzero/ids";

/**
 * Re-exported from `@editorzero/constants` (one protocol vocabulary,
 * both sides of the wire — `closeDocumentConnections` sends the same
 * code at per-document scope; the SPA provider classifies against it).
 */
export { COLLAB_REVOKED_CLOSE_CODE };

export interface CollabSocketLike {
  close(code?: number, reason?: string): void;
}

/**
 * A tracked socket, discriminated by the principal kind resolved at
 * upgrade (ADR 0044 Decision 5 — the registry key grows to carry agent
 * identity BEFORE the bearer WS arm enables, so a revoked agent / token
 * closes the right feeds):
 *
 *   - `user` — the cookie lane. Closes target `user_id` (session/role/
 *     membership revocation) or `session_id` (sign-out).
 *   - `agent` — the bearer lane (an `api-key` token presented at
 *     upgrade). Closes target the `agent_id` (the owning agent revoked,
 *     or its owner's membership removed) or the `token_id` (that one
 *     token revoked). `session_id` does not apply — agents hold no
 *     Better Auth session.
 */
export type CollabSocketEntry =
  | {
      readonly kind: "user";
      readonly user_id: UserId;
      /**
       * Session identity captured at upgrade — null is structurally
       * possible on `UserPrincipal` (token-borne principals) but the
       * cookie upgrade lane always carries one; a null entry simply
       * never matches a session-targeted close.
       */
      readonly session_id: SessionId | null;
      readonly socket: CollabSocketLike;
    }
  | {
      readonly kind: "agent";
      readonly agent_id: AgentId;
      readonly token_id: TokenId;
      readonly socket: CollabSocketLike;
    };

export interface CollabSocketRegistry {
  /**
   * Track an upgraded socket. Returns the release callback — idempotent,
   * wired to the socket's own `close` event by the caller so entries
   * never outlive their sockets.
   */
  register(entry: CollabSocketEntry): () => void;
  /** Close every `user`-kind socket the subject holds. Returns the count closed. */
  closeByUser(user_id: UserId): number;
  /** Close every `user`-kind socket riding the session. Returns the count closed. */
  closeBySession(session_id: SessionId): number;
  /** Close every `agent`-kind socket the agent holds. Returns the count closed. */
  closeByAgent(agent_id: AgentId): number;
  /** Close every `agent`-kind socket riding the token. Returns the count closed. */
  closeByToken(token_id: TokenId): number;
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
        entry.socket.close(COLLAB_REVOKED_CLOSE_CODE, COLLAB_REVOKED_REASON);
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
      return closeWhere((entry) => entry.kind === "user" && entry.user_id === user_id);
    },
    closeBySession(session_id) {
      return closeWhere((entry) => entry.kind === "user" && entry.session_id === session_id);
    },
    closeByAgent(agent_id) {
      return closeWhere((entry) => entry.kind === "agent" && entry.agent_id === agent_id);
    },
    closeByToken(token_id) {
      return closeWhere((entry) => entry.kind === "agent" && entry.token_id === token_id);
    },
    size() {
      return entries.size;
    },
  };
}
