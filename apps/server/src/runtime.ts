/**
 * Server lifecycle primitive for the `apps/server` boot entrypoint.
 *
 * `startServer` binds a {@link BootedApp}'s trunk to a TCP port over a
 * `node:http` server — adapting the Hono `fetch` handler with
 * `@hono/node-server`'s `getRequestListener` — and returns a
 * {@link RunningServer} whose `close()` performs a dependency-ordered
 * drain: release idle keep-alive sockets, stop the HTTP server (in-flight
 * requests finish), then tear down the booted stack (sync → driver, via
 * `BootedApp.close`).
 *
 * **Why a concrete `node:http` server, not `serve()`.** `@hono/node-server`'s
 * `serve()` returns an `http | http2` union, but `closeIdleConnections()`
 * — the call that stops `server.close()` from blocking until every idle
 * keep-alive client times out — exists only on `http.Server`. Owning the
 * concrete type makes the graceful drain correct without a union-narrowing
 * branch. The same concrete server is also where the ADR 0030 `/collab`
 * WebSocket `upgrade` handler attaches in the co-hosting smoke; whether
 * that arrives as `serve()` + v2 `upgradeWebSocket` or raw `ws` on this
 * server is a deliverable-#2 decision (ADR 0027 prerequisite smoke).
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
 * is already in use (`EADDRINUSE`).
 */
export function startServer(booted: BootedApp, port: number): Promise<RunningServer> {
  return new Promise<RunningServer>((resolve, reject) => {
    const server = createServer(getRequestListener(booted.app.fetch));
    // `error` before `listen` so a failed bind rejects rather than throwing
    // on an unhandled `error` event; dropped once we're listening.
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve({ port: portOf(server.address(), port), close: createClose(server, booted) });
    });
  });
}

function createClose(server: Server, booted: BootedApp): () => Promise<void> {
  let closed = false;
  return async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Release idle keep-alive sockets first, else `close()` blocks until
    // each client's keep-alive timeout elapses before the server settles.
    server.closeIdleConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await booted.close();
  };
}
