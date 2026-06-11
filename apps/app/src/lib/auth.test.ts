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
  it("passes through internal paths", () => {
    expect(safeRedirectTarget("/docs-home?x=1")).toBe("/docs-home?x=1");
    expect(safeRedirectTarget("/")).toBe("/");
  });

  it("clamps missing, external, and protocol-relative targets to home", () => {
    expect(safeRedirectTarget(undefined)).toBe("/");
    expect(safeRedirectTarget("")).toBe("/");
    expect(safeRedirectTarget("https://evil.example")).toBe("/");
    expect(safeRedirectTarget("//evil.example")).toBe("/");
    expect(safeRedirectTarget("javascript:alert(1)")).toBe("/");
  });
});
