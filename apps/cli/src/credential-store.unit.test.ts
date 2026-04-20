import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionCookieStore } from "./credential-store";

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
