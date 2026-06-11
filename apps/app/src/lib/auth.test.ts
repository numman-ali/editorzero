import type { AuthResult } from "@editorzero/api-client";
import { describe, expect, it } from "vitest";

import { authenticate, safeRedirectTarget } from "./auth";

function resolving(result: AuthResult) {
  const calls: unknown[] = [];
  const fn = async (input: unknown): Promise<AuthResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

describe("authenticate", () => {
  it("dispatches sign-in to the signIn seam with email + password only", async () => {
    const signIn = resolving({ ok: true });
    const signUp = resolving({ ok: true });
    const failure = await authenticate(
      "sign-in",
      { email: "a@b.test", password: "pw", name: "ignored" },
      { signIn: signIn.fn, signUp: signUp.fn },
    );
    expect(failure).toBeNull();
    expect(signIn.calls).toEqual([{ email: "a@b.test", password: "pw" }]);
    expect(signUp.calls).toEqual([]);
  });

  it("dispatches sign-up to the signUp seam with the name included", async () => {
    const signIn = resolving({ ok: true });
    const signUp = resolving({ ok: true });
    const failure = await authenticate(
      "sign-up",
      { email: "new@b.test", password: "pw", name: "New User" },
      { signIn: signIn.fn, signUp: signUp.fn },
    );
    expect(failure).toBeNull();
    expect(signUp.calls).toEqual([{ email: "new@b.test", password: "pw", name: "New User" }]);
    expect(signIn.calls).toEqual([]);
  });

  it("returns the server's failure message", async () => {
    const failure = await authenticate(
      "sign-in",
      { email: "a@b.test", password: "wrong", name: "" },
      { signIn: resolving({ ok: false, status: 401, message: "Invalid email or password" }).fn },
    );
    expect(failure).toBe("Invalid email or password");
  });

  it("maps a transport rejection to a friendly message instead of throwing", async () => {
    const throwingSignIn = async (): Promise<AuthResult> => {
      throw new Error("network down");
    };
    const failure = await authenticate(
      "sign-in",
      { email: "a@b.test", password: "pw", name: "" },
      { signIn: throwingSignIn },
    );
    expect(failure).toBe("Could not reach the server. Check your connection and try again.");
  });
});

describe("safeRedirectTarget", () => {
  const ORIGIN = "http://app.test";

  it("passes through internal paths, preserving query and hash", () => {
    expect(safeRedirectTarget("/docs-home?x=1", ORIGIN)).toBe("/docs-home?x=1");
    expect(safeRedirectTarget("/", ORIGIN)).toBe("/");
    expect(safeRedirectTarget("/a/b?q=a%2Fb#frag", ORIGIN)).toBe("/a/b?q=a%2Fb#frag");
  });

  it("clamps missing, external, and protocol-relative targets to home", () => {
    expect(safeRedirectTarget(undefined, ORIGIN)).toBe("/");
    expect(safeRedirectTarget("https://evil.example", ORIGIN)).toBe("/");
    expect(safeRedirectTarget("//evil.example", ORIGIN)).toBe("/");
    expect(safeRedirectTarget("javascript:alert(1)", ORIGIN)).toBe("/");
  });

  it("clamps backslash and encoded-separator forms that normalize to an authority", () => {
    // `new URL("/\\evil.com", base)` resolves to http://evil.com/ — the
    // browser treats the backslash as a slash.
    expect(safeRedirectTarget("/\\evil.com", ORIGIN)).toBe("/");
    expect(safeRedirectTarget("\\/evil.com", ORIGIN)).toBe("/");
    expect(safeRedirectTarget("/%5Cevil.com", ORIGIN)).toBe("/");
    expect(safeRedirectTarget("/%5cevil.com", ORIGIN)).toBe("/");
    // Same-origin after parsing, but an encoded slash in the *path* can
    // decode into `//evil.com` downstream — reject; legit encoded
    // slashes live in the query, which stays allowed above.
    expect(safeRedirectTarget("/%2Fevil.com", ORIGIN)).toBe("/");
    expect(safeRedirectTarget("///evil.com", ORIGIN)).toBe("/");
  });

  it("canonicalizes: the returned value is the re-assembled path, never the input", () => {
    // An empty string resolves to the base origin root.
    expect(safeRedirectTarget("", ORIGIN)).toBe("/");
    // A bare relative segment resolves inside the origin.
    expect(safeRedirectTarget("docs", ORIGIN)).toBe("/docs");
  });

  it("falls back to home when the base origin itself is unparseable", () => {
    expect(safeRedirectTarget("/fine", "not a url")).toBe("/");
  });

  it("defaults the base origin to the live environment origin", () => {
    // Under the node test runner the default resolves to the parseable
    // placeholder; an internal path passes through unchanged regardless
    // of the specific host.
    expect(safeRedirectTarget("/inside")).toBe("/inside");
  });
});
