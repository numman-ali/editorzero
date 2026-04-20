import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { AuthCredentialStore, CredentialHeaders } from "../credential-store";
import { runLogin } from "./login";

function makeStoreFake(): AuthCredentialStore & {
  readonly writes: CredentialHeaders[];
  readonly clears: number;
} {
  const writes: CredentialHeaders[] = [];
  let clears = 0;
  return {
    writes,
    get clears() {
      return clears;
    },
    async read() {
      return null;
    },
    async write(headers) {
      writes.push(headers);
    },
    async clear() {
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

const VALID_SET_COOKIE =
  "better-auth.session_token=abc123; Path=/; HttpOnly, better-auth.csrf=def456; Path=/";

describe("runLogin", () => {
  it("persists the cookie + emits ok on 200 with a valid Set-Cookie header", async () => {
    const store = makeStoreFake();
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "set-cookie": VALID_SET_COOKIE, "content-type": "application/json" },
        }),
    );

    const exit = await runLogin(
      { baseUrl: "http://localhost:3000", email: "alice@example.com", password: "pw" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    expect(store.writes).toHaveLength(1);
    // biome-ignore lint/complexity/useLiteralKeys: TS4111 — CredentialHeaders is a Record<string, string> index signature, bracket access required.
    expect(store.writes[0]?.["cookie"]).toContain("better-auth.session_token=abc123");
    // biome-ignore lint/complexity/useLiteralKeys: TS4111 — same as above.
    expect(store.writes[0]?.["cookie"]).toContain("better-auth.csrf=def456");
    expect(JSON.parse(read())).toEqual({ ok: true, email: "alice@example.com" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/auth/sign-in/email",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("emits auth_failed + exits 1 on a non-200 response", async () => {
    const store = makeStoreFake();
    const { stream, read } = captured();
    const fetch = vi.fn(async () => new Response("", { status: 401 }));

    const exit = await runLogin(
      { baseUrl: "http://localhost:3000", email: "x@y.com", password: "wrong" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    expect(store.writes).toHaveLength(0);
    const body = JSON.parse(read()) as { error: { code: string; status: number } };
    expect(body.error.code).toBe("auth_failed");
    expect(body.error.status).toBe(401);
  });

  it("emits auth_missing_cookie + exits 1 on a 200 without Set-Cookie", async () => {
    const store = makeStoreFake();
    const { stream, read } = captured();
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));

    const exit = await runLogin(
      { baseUrl: "http://localhost:3000", email: "x@y.com", password: "pw" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    expect(store.writes).toHaveLength(0);
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_missing_cookie");
  });

  it("emits network_error + exits 1 when fetch rejects", async () => {
    const store = makeStoreFake();
    const { stream, read } = captured();
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const exit = await runLogin(
      { baseUrl: "http://localhost:3000", email: "x@y.com", password: "pw" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("network_error");
    expect(body.error.message).toBe("ECONNREFUSED");
  });

  it("handles a network error where the thrown value has no message", async () => {
    const store = makeStoreFake();
    const { stream, read } = captured();
    const fetch = vi.fn(async () => {
      throw new Error();
    });

    const exit = await runLogin(
      { baseUrl: "http://localhost:3000", email: "x@y.com", password: "pw" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string; message: string } };
    // `new Error()` has `message: ""` — the `?? "unknown"` fallback only
    // fires when message is nullish, not empty string. Guard the real
    // behaviour: empty string flows through.
    expect(body.error.code).toBe("network_error");
    expect(body.error.message).toBe("");
  });

  it("extracts a single-cookie Set-Cookie correctly (no comma to split on)", async () => {
    const store = makeStoreFake();
    const { stream } = captured();
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "set-cookie": "better-auth.session_token=solo; Path=/; HttpOnly" },
        }),
    );

    const exit = await runLogin(
      { baseUrl: "http://localhost:3000", email: "x@y.com", password: "pw" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    // biome-ignore lint/complexity/useLiteralKeys: TS4111 — CredentialHeaders is a Record<string, string> index signature, bracket access required.
    expect(store.writes[0]?.["cookie"]).toBe("better-auth.session_token=solo");
  });
});
