/**
 * Server lifecycle primitive for the `apps/server` boot entrypoint.
 *
 * `startServer` binds a {@link BootedApp}'s trunk to a TCP port over a
 * `node:http` server — adapting the Hono `fetch` handler with
 * `@hono/node-server`'s `getRequestListener` — and returns a
 * {@link RunningServer} whose `close()` performs a dependency-ordered
 * drain: close protocol attachments (live WebSocket clients), release
 * idle keep-alive sockets, stop the HTTP server (in-flight requests
 * finish), then tear down the booted stack (sync → driver, via
 * `BootedApp.close`).
 *
 * **Why a concrete `node:http` server, not `serve()`.** `@hono/node-server`'s
 * `serve()` returns an `http | http2` union, but `closeIdleConnections()`
 * — the call that stops `server.close()` from blocking until every idle
 * keep-alive client times out — exists only on `http.Server`. Owning the
 * concrete type makes the graceful drain correct without a union-narrowing
 * branch. The same concrete server is where the ADR 0030 `/collab`
 * WebSocket `upgrade` handler mounts, via the `attach` parameter —
 * raw `ws` (`WebSocketServer({ noServer })`), the topology the
 * co-hosting smoke proved (deliverable #2; no `serve()` v2 bump needed).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { BootedApp } from "@editorzero/api-server";
import { getRequestListener } from "@hono/node-server";

export interface RunningServer {
  /** The actual bound port — resolves a requested `0` to the OS-assigned port. */
  readonly port: number;
  /** Drain idle connections, stop the HTTP server, tear down the stack. Idempotent. */
  readonly close: () => Promise<void>;
}

/**
 * A protocol handler mounted on the raw `http.Server` (today:
 * `attachCollab`'s WebSocket upgrade). Its `close()` runs FIRST in the
 * drain: upgraded sockets count as open server connections, so live
 * WebSocket clients must be terminated before `server.close()` — which
 * waits for every remaining connection — or the drain never settles.
 */
export interface ServerAttachment {
  readonly close: () => void | Promise<void>;
}

/**
 * The bound TCP port from a listening server's `address()`. A server
 * listening on a port yields an `AddressInfo`; the `string` (IPC pipe)
 * and `null` (not listening) cases can't occur on this path but are
 * narrowed without a cast, falling back to the requested port. Exported
 * for direct unit test of both arms.
 */
export function portOf(address: AddressInfo | string | null, fallback: number): number {
  return address !== null && typeof address === "object" ? address.port : fallback;
}

/**
 * Bind `booted`'s trunk to `port` and resolve once listening (resolving
 * `0` to an OS-assigned port). Rejects if the bind fails — e.g. the port
 * is already in use (`EADDRINUSE`). Each `attach` hook receives the
 * concrete server BEFORE it starts listening — protocol handlers (the
 * `/collab` WebSocket upgrade) mount race-free — and its returned
 * attachment is closed first in the drain.
 */
export function startServer(
  booted: BootedApp,
  port: number,
  attach: ReadonlyArray<(server: Server) => ServerAttachment> = [],
): Promise<RunningServer> {
  return new Promise<RunningServer>((resolve, reject) => {
    const server = createServer(getRequestListener(booted.app.fetch));
    const attachments = attach.map((mount) => mount(server));
    // `error` before `listen` so a failed bind rejects rather than throwing
    // on an unhandled `error` event; dropped once we're listening.
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve({
        port: portOf(server.address(), port),
        close: createClose(server, booted, attachments),
      });
    });
  });
}

function createClose(
  server: Server,
  booted: BootedApp,
  attachments: readonly ServerAttachment[],
): () => Promise<void> {
  let closed = false;
  return async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Attachments first: terminate upgraded sockets (live WebSocket
    // clients) so `server.close()` below isn't waiting on them.
    for (const attachment of attachments) {
      await attachment.close();
    }
    // Release idle keep-alive sockets next, else `close()` blocks until
    // each client's keep-alive timeout elapses before the server settles.
    server.closeIdleConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await booted.close();
  };
}
