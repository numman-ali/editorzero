import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BearerTokenStore, createCredentialStore, SessionCookieStore } from "./credential-store";

// Prefix + exactly 43 base62 chars — a shape-valid agent token (the
// store does not itself validate; the server's bearer arm does). Kept in
// sync with `isWellFormedAgentToken`'s contract in @editorzero/capabilities.
const AGENT_TOKEN = "ez_agent_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";

const created: string[] = [];

function makeStore(): { store: SessionCookieStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "editorzero-cli-cred-"));
  const path = join(dir, "credentials");
  created.push(path);
  return { store: new SessionCookieStore({ path }), path };
}

afterEach(() => {
  // Each test dir is unique (mkdtemp); leaving them behind is cheap
  // and avoids a rm-rf landmine in parallel runs.
});

describe("SessionCookieStore", () => {
  it("read returns null when the file does not exist (ENOENT)", async () => {
    const { store } = makeStore();
    expect(await store.read()).toBeNull();
  });

  it("write + read round-trips a cookie header", async () => {
    const { store } = makeStore();
    await store.write({ cookie: "better-auth.session_token=abc123" });
    expect(await store.read()).toEqual({ cookie: "better-auth.session_token=abc123" });
  });

  it("write persists with 0600 file permissions", async () => {
    const { store, path } = makeStore();
    await store.write({ cookie: "x=y" });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("write throws when the headers object has no `cookie` key", async () => {
    const { store } = makeStore();
    await expect(store.write({})).rejects.toThrow(/no `cookie` in headers/);
  });

  it("write accepts a capitalized `Cookie` key (common from Headers.get)", async () => {
    const { store, path } = makeStore();
    await store.write({ Cookie: "x=y" });
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ cookie: "x=y" });
  });

  it("clear removes the file", async () => {
    const { store, path } = makeStore();
    await store.write({ cookie: "x=y" });
    await store.clear();
    expect(await store.read()).toBeNull();
    expect(() => statSync(path)).toThrow();
  });

  it("clear is idempotent when the file is already absent", async () => {
    const { store } = makeStore();
    await store.clear();
    await store.clear();
    expect(await store.read()).toBeNull();
  });

  it("read returns null on corrupted JSON (instead of throwing)", async () => {
    const { store, path } = makeStore();
    writeFileSync(path, "not-json", { mode: 0o600 });
    expect(await store.read()).toBeNull();
  });

  it("read returns null when the parsed value is not an object", async () => {
    const { store, path } = makeStore();
    writeFileSync(path, "null", { mode: 0o600 });
    expect(await store.read()).toBeNull();
  });

  it("read returns null when the parsed value lacks a `cookie` key", async () => {
    const { store, path } = makeStore();
    writeFileSync(path, JSON.stringify({ foo: "bar" }), { mode: 0o600 });
    expect(await store.read()).toBeNull();
  });

  it("read returns null when the `cookie` value is an empty string", async () => {
    const { store, path } = makeStore();
    writeFileSync(path, JSON.stringify({ cookie: "" }), { mode: 0o600 });
    expect(await store.read()).toBeNull();
  });

  it("defaults the path to ~/.editorzero/credentials when no options given", () => {
    const store = new SessionCookieStore();
    expect(store.path).toMatch(/\.editorzero\/credentials$/u);
  });
});

describe("BearerTokenStore", () => {
  it("read returns an `Authorization: Bearer` header carrying the token", async () => {
    const store = new BearerTokenStore(AGENT_TOKEN);
    expect(await store.read()).toEqual({ authorization: `Bearer ${AGENT_TOKEN}` });
  });

  it("read is stable across calls — the token is the credential, no logged-out state", async () => {
    const store = new BearerTokenStore(AGENT_TOKEN);
    const first = await store.read();
    const second = await store.read();
    expect(first).toEqual(second);
    expect(first).not.toBeNull();
  });

  it("write throws — the credential is env-sourced, not CLI-writable", async () => {
    const store = new BearerTokenStore(AGENT_TOKEN);
    await expect(store.write({ authorization: "Bearer other" })).rejects.toThrow(
      /EDITORZERO_AGENT_TOKEN/u,
    );
  });

  it("clear is a no-op (nothing local to remove) and leaves read intact", async () => {
    const store = new BearerTokenStore(AGENT_TOKEN);
    await expect(store.clear()).resolves.toBeUndefined();
    // A 401-driven clear must NOT wipe the credential — the token lives in
    // the environment; re-minting is an owner action, not a local clear.
    expect(await store.read()).toEqual({ authorization: `Bearer ${AGENT_TOKEN}` });
  });
});

describe("createCredentialStore", () => {
  it("returns a BearerTokenStore when a non-empty agent token is present", () => {
    expect(createCredentialStore(AGENT_TOKEN)).toBeInstanceOf(BearerTokenStore);
  });

  it("returns a SessionCookieStore when the token is undefined", () => {
    expect(createCredentialStore(undefined)).toBeInstanceOf(SessionCookieStore);
  });

  it("returns a SessionCookieStore when the token is the empty string (e.g. `EDITORZERO_AGENT_TOKEN=`)", () => {
    expect(createCredentialStore("")).toBeInstanceOf(SessionCookieStore);
  });
});
