/**
 * Unit lane for the `/collab` upgrade boundary: the `originAllowed`
 * matrix (Codex review SHOULD-FIX — normalized comparison, not string
 * equality) and the refusal branches of `attachCollab`'s upgrade
 * handler, driven by emitting synthetic `upgrade` events against
 * structural fakes. The accept path (real WebSocket handshake into
 * Hocuspocus) lives in `cohost.integration.test.ts` — it needs a real
 * booted stack.
 */

import { createServer, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";

import { isReservedApiPath } from "@editorzero/constants";
import { describe, expect, it } from "vitest";

import { attachCollab, COLLAB_PATH, type CollabBooted, originAllowed } from "./collab";

const ALLOWED = "http://localhost:3000";

describe("originAllowed", () => {
  it("accepts exactly the configured origin", () => {
    expect(originAllowed("http://localhost:3000", ALLOWED)).toBe(true);
  });

  it("normalizes config noise (trailing slash, path) instead of string-comparing", () => {
    expect(originAllowed("http://localhost:3000", "http://localhost:3000/")).toBe(true);
    expect(originAllowed("http://localhost:3000", "http://localhost:3000/app")).toBe(true);
  });

  it("normalizes default ports on both sides", () => {
    expect(originAllowed("https://ez.example", "https://ez.example:443")).toBe(true);
    expect(originAllowed("http://ez.example:80", "http://ez.example")).toBe(true);
  });

  it("rejects an absent Origin (browser clients always send one)", () => {
    expect(originAllowed(undefined, ALLOWED)).toBe(false);
  });

  it("rejects scheme, host, and port mismatches", () => {
    expect(originAllowed("https://localhost:3000", ALLOWED)).toBe(false);
    expect(originAllowed("http://evil.example", ALLOWED)).toBe(false);
    expect(originAllowed("http://localhost:3001", ALLOWED)).toBe(false);
  });

  it("rejects folded / repeated header values", () => {
    expect(originAllowed("http://localhost:3000, http://evil.example", ALLOWED)).toBe(false);
  });

  it("rejects malformed and opaque values", () => {
    expect(originAllowed("null", ALLOWED)).toBe(false);
    expect(originAllowed("not a url", ALLOWED)).toBe(false);
    expect(originAllowed("", ALLOWED)).toBe(false);
  });

  it("fails closed when the configured origin itself is malformed", () => {
    expect(originAllowed("http://localhost:3000", "not a url")).toBe(false);
  });
});

describe("COLLAB_PATH", () => {
  it("is a reserved API prefix (ADR 0035 §2 — SPA fallback / SW denylist honor it)", () => {
    expect(isReservedApiPath(COLLAB_PATH)).toBe(true);
  });
});

/**
 * Drive one synthetic `upgrade` event through `attachCollab`'s handler
 * and capture what the socket saw. `PassThrough` is a real `Duplex`, so
 * no casts: the refusal path writes a plain HTTP status line and
 * destroys.
 */
async function emitUpgrade(
  booted: CollabBooted,
  headers: Record<string, string>,
  url = COLLAB_PATH,
): Promise<{ wire: string; destroyed: boolean }> {
  const server = createServer();
  try {
    attachCollab(server, booted, { publicOrigin: ALLOWED });
    const socket = new PassThrough();
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    // Structural IncomingMessage: the handler reads `url` + `headers`.
    const req: Pick<IncomingMessage, "url" | "headers"> = { url, headers };
    server.emit("upgrade", req, socket, Buffer.alloc(0));
    // The handler is async (resolver await); give it two macrotasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { wire: Buffer.concat(chunks).toString("utf8"), destroyed: socket.destroyed };
  } finally {
    server.close();
  }
}

/** A resolver-only fake; `handleWsConnection` must not be reached. */
function refusalBooted(resolver: CollabBooted["resolver"]): CollabBooted {
  return {
    resolver,
    sync: {
      handleWsConnection: () => {
        throw new Error("handleWsConnection must not be reached on a refusal path");
      },
    },
  };
}

describe("attachCollab refusal branches", () => {
  it("refuses non-collab upgrade paths with 404", async () => {
    const { wire, destroyed } = await emitUpgrade(
      refusalBooted(() => Promise.resolve(null)),
      { origin: ALLOWED },
      "/not-collab",
    );
    expect(wire).toContain("HTTP/1.1 404");
    expect(destroyed).toBe(true);
  });

  it("refuses a wrong Origin with 403 before touching the resolver", async () => {
    const { wire } = await emitUpgrade(
      refusalBooted(() => Promise.reject(new Error("resolver must not run"))),
      { origin: "http://evil.example", cookie: "session=x" },
    );
    expect(wire).toContain("HTTP/1.1 403");
  });

  it("refuses an absent Origin with 403", async () => {
    const { wire } = await emitUpgrade(
      refusalBooted(() => Promise.resolve(null)),
      {
        cookie: "session=x",
      },
    );
    expect(wire).toContain("HTTP/1.1 403");
  });

  it("refuses an unauthenticated session with 401", async () => {
    const { wire } = await emitUpgrade(
      refusalBooted(() => Promise.resolve(null)),
      {
        origin: ALLOWED,
        cookie: "session=expired",
      },
    );
    expect(wire).toContain("HTTP/1.1 401");
  });

  it("fails closed (destroy, no upgrade) when the resolver throws", async () => {
    const { destroyed } = await emitUpgrade(
      refusalBooted(() => Promise.reject(new Error("auth backend down"))),
      { origin: ALLOWED, cookie: "session=x" },
    );
    expect(destroyed).toBe(true);
  });
});
