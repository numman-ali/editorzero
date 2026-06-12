/**
 * Collab WS revocation-close protocol constants (ADR 0043 Decision 5).
 *
 * One value, two sides of the wire — the server emits these (socket-
 * level registry closes, per-document room closes), and the browser
 * collab binding classifies inbound closes against them. A drift
 * would make a legitimate client misread a revocation as a transport
 * hiccup and blind-retry into a reconnect storm.
 *
 * Import-free leaf module (the `reserved-prefixes.ts` pattern).
 */

/**
 * WebSocket close code for revocation closes (app range 4000–4999).
 * Sent at the SOCKET level by the composition root's registry. A
 * legitimate client reads it as "re-auth, don't blind-retry" —
 * distinguishable from transport hiccups.
 *
 * Per-DOCUMENT closes carry only `COLLAB_REVOKED_REASON`: the
 * Hocuspocus multiplexed Close message has no code field on the wire
 * (the 3.4.4 provider synthesizes `code: 1000`), so doc-level
 * classification reads the reason string.
 */
export const COLLAB_REVOKED_CLOSE_CODE = 4401;

/**
 * Close reason accompanying every revocation close — the discriminant
 * for per-document closes (see `COLLAB_REVOKED_CLOSE_CODE`). Other
 * server-initiated per-doc closes (write-gate refusals, server
 * exceptions) carry Hocuspocus's generic "Reset Connection".
 */
export const COLLAB_REVOKED_REASON = "authorization revoked";
