import { describe, expect, it } from "vitest";

import { signInEmail, signUpEmail } from "./auth";

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function fetchReturning(status: number, body: string | null, calls: CapturedCall[]) {
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
  return fetchImpl;
}

describe("signInEmail", () => {
  it("POSTs the credentials to /auth/sign-in/email with credentials included", async () => {
    const calls: CapturedCall[] = [];
    const result = await signInEmail(
      { email: "a@b.test", password: "pw" },
      { baseUrl: "http://api.test", fetch: fetchReturning(200, "{}", calls) },
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api.test/auth/sign-in/email");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ email: "a@b.test", password: "pw" }));
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("defaults to same-origin relative paths (empty baseUrl)", async () => {
    const calls: CapturedCall[] = [];
    await signInEmail(
      { email: "a@b.test", password: "pw" },
      { fetch: fetchReturning(200, "{}", calls) },
    );
    expect(calls[0]?.url).toBe("/auth/sign-in/email");
  });

  it("surfaces Better Auth's { message } body on failure", async () => {
    const result = await signInEmail(
      { email: "a@b.test", password: "wrong" },
      {
        fetch: fetchReturning(401, JSON.stringify({ message: "Invalid email or password" }), []),
      },
    );
    expect(result).toEqual({ ok: false, status: 401, message: "Invalid email or password" });
  });

  it("falls back to a status line for a non-JSON failure body", async () => {
    const result = await signInEmail(
      { email: "a@b.test", password: "pw" },
      { fetch: fetchReturning(500, "<html>boom</html>", []) },
    );
    expect(result).toEqual({ ok: false, status: 500, message: "Request failed (HTTP 500)." });
  });

  it("falls back when the JSON body has no usable message", async () => {
    const result = await signInEmail(
      { email: "a@b.test", password: "pw" },
      { fetch: fetchReturning(403, JSON.stringify({ message: "" }), []) },
    );
    expect(result).toEqual({ ok: false, status: 403, message: "Request failed (HTTP 403)." });
  });

  it("propagates transport failures as rejections", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("network down");
    };
    await expect(
      signInEmail({ email: "a@b.test", password: "pw" }, { fetch: failingFetch }),
    ).rejects.toThrow("network down");
  });
});

describe("signUpEmail", () => {
  it("POSTs email + password + name to /auth/sign-up/email", async () => {
    const calls: CapturedCall[] = [];
    const result = await signUpEmail(
      { email: "new@b.test", password: "pw", name: "New User" },
      { fetch: fetchReturning(200, "{}", calls) },
    );
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/auth/sign-up/email");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ email: "new@b.test", password: "pw", name: "New User" }),
    );
  });

  it("projects a duplicate-account failure to its message", async () => {
    const result = await signUpEmail(
      { email: "dupe@b.test", password: "pw", name: "Dupe" },
      { fetch: fetchReturning(422, JSON.stringify({ message: "User already exists" }), []) },
    );
    expect(result).toEqual({ ok: false, status: 422, message: "User already exists" });
  });
});
