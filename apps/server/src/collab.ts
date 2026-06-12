/**
 * Production `/collab` WebSocket attach (ADR 0030 hardening, task #15).
 *
 * Owns the upgrade-time boundary on the production `http.Server` —
 * everything that must be decided BEFORE a socket reaches Hocuspocus:
 *
 *   1. **Path.** Only `COLLAB_PATH` upgrades; anything else is refused
 *      with a plain HTTP response. (`/collab` is in
 *      `RESERVED_API_PREFIXES` — pinned by the unit test — so the SPA
 *      fallback / SW denylist already treat it as trunk-owned.)
 *   2. **Origin allow-list.** The raw upgrade request never passes
 *      through Hono or Better Auth's CORS handling, so cross-site
 *      WebSocket hijacking must be refused HERE: browsers attach the
 *      session cookie to `wss://` requests from ANY origin. Origins
 *      are compared normalized (`new URL(...).origin` on both sides —
 *      a trailing slash or path in config must not break legitimate
 *      clients; string weirdness must not admit illegitimate ones).
 *      An ABSENT Origin is refused too: every supported client today
 *      is a browser (the cookie path), browsers always send Origin on
 *      WebSocket upgrades, and absence-tolerance only shields a
 *      non-browser client that could fake the header anyway. Native /
 *      bearer-token clients get their own rule when that auth path
 *      lands (ADR 0030 slice B).
 *   3. **Session authN.** The cookie resolves through the SAME
 *      `BetterAuthResolver` the trunk uses (`booted.resolver` —
 *      invariant 5: one identity source). An unauthenticated socket is
 *      refused at upgrade rather than left half-open for Hocuspocus's
 *      Auth-frame timeout to collect.
 *
 * Everything per-document — authorization against the ACL ceiling,
 * revocation freshness, forced readOnly — happens AFTER the upgrade,
 * per Auth frame, inside `HocuspocusSync`'s constructor-registered
 * `onAuthenticate` (see `collabAuthorize` in the api-server
 * composition root). The upgrade principal is deliberately NOT handed
 * to the connection: identity is re-resolved per Auth frame, so the
 * early resolve here is purely a cheap refusal gate.
 *
 * **Close ordering.** Upgraded sockets count as open server
 * connections, so `server.close()` would wait on live WS clients
 * forever. The returned attachment's `close()` terminates them; the
 * runtime's drain runs attachments BEFORE the HTTP close (see
 * `createClose` in runtime.ts).
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import type { BootedApp } from "@editorzero/api-server";
import { type Logger, noopLogger } from "@editorzero/observability";
import { WebSocketServer } from "ws";

import type { ServerAttachment } from "./runtime";

export const COLLAB_PATH = "/collab";

/**
 * Normalized Origin check for the raw WebSocket upgrade. `undefined`
 * (absent header) refuses — see the file header for why. A folded /
 * repeated Origin (`a, b`) and any unparseable value refuse: there is
 * exactly one legitimate shape, a single well-formed origin equal to
 * the deployment's `public_origin`. Opaque origins (`null` and
 * friends) can never equal an http(s) origin, but the explicit guard
 * documents the intent.
 */
export function originAllowed(originHeader: string | undefined, publicOrigin: string): boolean {
  if (originHeader === undefined || /[\s,]/u.test(originHeader)) return false;
  let origin: URL;
  let allowed: URL;
  try {
    origin = new URL(originHeader);
    allowed = new URL(publicOrigin);
  } catch {
    return false;
  }
  return origin.origin !== "null" && origin.origin === allowed.origin;
}

export interface AttachCollabOptions {
  /** The deployment origin WS upgrades must come from (`config.public_origin`). */
  readonly publicOrigin: string;
  /** Structured logger for refused upgrades. Defaults to `noopLogger`. */
  readonly logger?: Logger;
}

/**
 * The slice of {@link BootedApp} the attach actually consumes — narrow
 * so the refusal branches unit-test against structural fakes instead
 * of a fully booted stack (production passes the real `BootedApp`).
 */
export type CollabBooted = Pick<BootedApp, "resolver"> & {
  readonly sync: Pick<BootedApp["sync"], "handleWsConnection">;
};

/** Minimal HTTP refusal on a not-yet-upgraded socket, then hang up. */
function refuse(socket: Duplex, status: number, reason: string): void {
  // The socket is still in HTTP-land (the upgrade was not completed),
  // so a plain status line is the protocol-correct refusal — clients
  // see a real HTTP error instead of an opaque TCP reset.
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Mount the collab WebSocket upgrade handler on `server`, routing
 * accepted sockets into `booted.sync` (the SAME embedded Hocuspocus
 * the dispatcher writes through — that identity is what makes live
 * convergence work; a second instance would never see HTTP writes).
 */
export function attachCollab(
  server: Server,
  booted: CollabBooted,
  options: AttachCollabOptions,
): ServerAttachment {
  const log = options.logger ?? noopLogger;
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const pathname = new URL(req.url ?? "/", "http://upgrade.internal").pathname;
    if (pathname !== COLLAB_PATH) {
      refuse(socket, 404, "Not Found");
      return;
    }
    if (!originAllowed(req.headers.origin, options.publicOrigin)) {
      log.warn("collab upgrade refused: origin", {
        event: "hocuspocus.authenticate",
        "collab.origin": req.headers.origin ?? "(absent)",
      });
      refuse(socket, 403, "Forbidden");
      return;
    }
    // authN only — authZ is per-document, per Auth frame, downstream.
    const headers = new Headers();
    if (typeof req.headers.cookie === "string") headers.set("cookie", req.headers.cookie);
    const principal = await booted.resolver(headers);
    if (principal === null) {
      log.warn("collab upgrade refused: unauthenticated", {
        event: "hocuspocus.authenticate",
      });
      refuse(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      booted.sync.handleWsConnection(client, req);
    });
  };

  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((error: unknown) => {
      // Fail closed: any resolution error refuses the upgrade.
      log.warn("collab upgrade refused: error", {
        event: "hocuspocus.authenticate",
        "collab.reason": error instanceof Error ? error.message : String(error),
      });
      socket.destroy();
    });
  });

  return {
    close: () => {
      // `terminate` (not `close`): the drain must not wait for close
      // handshakes — `server.close()` blocks until these sockets die.
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
