import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { AuthCredentialStore, CredentialHeaders } from "../credential-store";
import { runWhoami } from "./whoami";

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

const USER_PRINCIPAL = {
  kind: "user",
  id: "018f0000-0000-7000-8000-0000000000a1",
  workspace_id: "018f0000-0000-7000-8000-0000000000b1",
  roles: ["owner"],
  session_id: "018f0000-0000-7000-8000-0000000000d1",
  token_id: null,
};

describe("runWhoami", () => {
  it("emits auth_expired + exits 1 when no local credential exists", async () => {
    const store = makeStoreFake(null);
    const { stream, read } = captured();
    const fetch = vi.fn();

    const exit = await runWhoami(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_expired");
  });

  it("emits the Principal body + exits 0 on a 200 response", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(USER_PRINCIPAL), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const exit = await runWhoami(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    expect(JSON.parse(read())).toEqual(USER_PRINCIPAL);
    expect(store.clears).toBe(0);
  });

  it("forwards the stored cookie header on the typed-client fetch", async () => {
    const store = makeStoreFake({ cookie: "better-auth.session_token=xyz" });
    const { stream } = captured();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(USER_PRINCIPAL), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await runWhoami({ baseUrl: "http://localhost:3000" }, { store, fetch, stdout: stream });

    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const headers = new Headers(call[1]?.headers);
    expect(headers.get("cookie")).toBe("better-auth.session_token=xyz");
  });

  it("clears the local credential + emits auth_expired on a 401 response", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );

    const exit = await runWhoami(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    expect(store.clears).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_expired");
  });

  it("emits request_failed on any non-200 non-401 response", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => new Response("", { status: 500 }));

    const exit = await runWhoami(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string; status: number } };
    expect(body.error.code).toBe("request_failed");
    expect(body.error.status).toBe(500);
    expect(store.clears).toBe(0);
  });

  it("emits network_error when the typed client's fetch rejects", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => {
      throw new Error("DNS failed");
    });

    const exit = await runWhoami(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("network_error");
    expect(body.error.message).toBe("DNS failed");
  });

  it("handles a network error with a non-Error throw value (falls back to 'unknown')", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => {
      // `unknown` throw — err.message is undefined → fallback fires.
      throw new Error();
    });

    const exit = await runWhoami(
      { baseUrl: "http://localhost:3000" },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("network_error");
    expect(body.error.message).toBe("");
  });
});
