import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { AuthCredentialStore, CredentialHeaders } from "../credential-store";
import { runLogout } from "./logout";

function makeStoreFake(initial: CredentialHeaders | null): AuthCredentialStore & {
  clears: number;
} {
  let current = initial;
  let clears = 0;
  return {
    get clears() {
      return clears;
    },
    async read() {
      return current;
    },
    async write(headers) {
      current = headers;
    },
    async clear() {
      current = null;
      clears += 1;
    },
  };
}

function captured(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

describe("runLogout", () => {
  it("emits already=true + exits 0 when no credential exists (idempotent)", async () => {
    const store = makeStoreFake(null);
    const { stream, read } = captured();
    const fetch = vi.fn();

    const exit = await runLogout(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.clears).toBe(0);
    expect(JSON.parse(read())).toEqual({ ok: true, already: true });
  });

  it("hits /auth/sign-out + clears locally + emits server_cleared=true on 2xx", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => new Response("", { status: 200 }));

    const exit = await runLogout(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/auth/sign-out",
      expect.objectContaining({ method: "POST", headers: { cookie: "session=x" } }),
    );
    expect(store.clears).toBe(1);
    expect(JSON.parse(read())).toEqual({ ok: true, server_cleared: true });
  });

  it("clears locally + emits server_cleared=false + exits 0 when the server returns 5xx", async () => {
    // We accept the local state as authoritative for "I am logged out
    // here"; the server might keep the session row around until its TTL
    // lapses. Not a command failure from the user's POV.
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => new Response("", { status: 503 }));

    const exit = await runLogout(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    expect(store.clears).toBe(1);
    expect(JSON.parse(read())).toEqual({ ok: true, server_cleared: false });
  });

  it("clears locally + emits server_cleared=false when fetch rejects", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const exit = await runLogout(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    expect(store.clears).toBe(1);
    expect(JSON.parse(read())).toEqual({ ok: true, server_cleared: false });
  });
});
