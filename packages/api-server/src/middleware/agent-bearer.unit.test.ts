/**
 * `createBearerThenCookieResolver` — bearer-arm unit tests (ADR 0044
 * Decision 4).
 *
 * Mounts the composed resolver behind the real `createPrincipalMiddleware`
 * on a tiny probe app (mirroring `principal.unit.test.ts`), then drives it
 * with crafted `Authorization` headers. Pins the routing contract:
 *
 *   - no Bearer  → cookie resolver consulted (and its result honored)
 *   - valid agent Bearer → `AgentPrincipal` (api-key, scopes parsed,
 *     `acting_as` absent); the cookie resolver is NOT consulted
 *   - invalid / unknown / non-`ez_agent_` Bearer → 401, NEVER a cookie
 *     fallback (the confused-deputy guard)
 *   - Bearer wins when a cookie is ALSO present
 *   - non-Bearer `Authorization` (e.g. Basic) → deferred to the cookie
 *   - corrupt stored scopes → the parser throws → 500 (not a silent 401)
 *
 * The agent-token lookup and cookie resolver are fakes; the hashing
 * (`hashAgentToken`) and scope parsing run for real, so the test also
 * pins that the presented secret is hashed before lookup.
 */

import { hashAgentToken } from "@editorzero/capabilities";
import type { AgentTokenResolution } from "@editorzero/db";
import { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { isAgent } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { ApiEnv } from "../env";
import { createBearerThenCookieResolver, hasBearerScheme } from "./agent-bearer";
import { createPrincipalMiddleware } from "./principal";

const WORKSPACE = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const OWNER = UserId("018f0000-0000-7000-8000-0000000000a1");
const AGENT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const TOKEN = TokenId("018f0000-0000-7000-8000-0000000000c1");

const COOKIE_USER: UserPrincipal = {
  kind: "user",
  id: OWNER,
  workspace_id: WORKSPACE,
  roles: ["member"],
  session_id: null,
  token_id: null,
};

// Prefix + exactly 43 base62 chars (10 digits + A-Z + a-g) — well-formed.
const LIVE_TOKEN = "ez_agent_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";
const SCOPES_JSON = JSON.stringify(["doc:read", "workspace:read"]);

const LIVE_RESOLUTION: AgentTokenResolution = {
  token_id: TOKEN,
  agent_id: AGENT,
  workspace_id: WORKSPACE,
  owner_user_id: OWNER,
  scopes: SCOPES_JSON,
};

/**
 * Probe app: the composed resolver behind the production principal
 * middleware. The probe route echoes the resolved principal's
 * discriminating fields so each assertion can read what was set.
 */
function buildProbeApp(opts: {
  resolveAgentToken: (hash: string) => Promise<AgentTokenResolution | null>;
  cookieResolve: (headers: Headers) => Promise<UserPrincipal | null>;
}) {
  const resolve = createBearerThenCookieResolver(opts);
  const app = new Hono<ApiEnv>();
  app.use("*", createPrincipalMiddleware({ resolve }));
  app.get("/probe", (c) => {
    const principal = c.var.principal;
    if (isAgent(principal)) {
      return c.json({
        kind: principal.kind,
        token_kind: principal.token_kind,
        token_id: principal.token_id,
        owner_user_id: principal.owner_user_id,
        scopes: principal.scopes,
        acting_as: principal.acting_as ?? null,
      });
    }
    return c.json({ kind: principal.kind, id: principal.id });
  });
  return app;
}

describe("hasBearerScheme (the shared lane discriminant)", () => {
  it("is true for a Bearer header, case-insensitively (RFC 6750), and false otherwise", () => {
    expect(hasBearerScheme("Bearer abc")).toBe(true);
    expect(hasBearerScheme("bearer abc")).toBe(true);
    expect(hasBearerScheme("Bearer\tabc")).toBe(true);
    // Not the Bearer scheme — these are the cookie lane / no agent attempt.
    expect(hasBearerScheme(undefined)).toBe(false);
    expect(hasBearerScheme("")).toBe(false);
    expect(hasBearerScheme("Basic dXNlcjpwYXNz")).toBe(false);
    expect(hasBearerScheme("Bearer")).toBe(false); // scheme needs a credential
  });
});

describe("createBearerThenCookieResolver", () => {
  it("defers to the cookie resolver when no Authorization header is present", async () => {
    const resolveAgentToken = vi.fn(async () => null);
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    const res = await app.request("/probe");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("user");
    expect(cookieResolve).toHaveBeenCalledOnce();
    expect(resolveAgentToken).not.toHaveBeenCalled();
  });

  it("resolves a live agent Bearer to an api-key AgentPrincipal, cookie untouched", async () => {
    const resolveAgentToken = vi.fn(async () => LIVE_RESOLUTION);
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    const res = await app.request("/probe", {
      headers: { authorization: `Bearer ${LIVE_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      token_kind: string;
      token_id: string;
      owner_user_id: string;
      scopes: string[];
      acting_as: string | null;
    };
    expect(body).toEqual({
      kind: "agent",
      token_kind: "api-key",
      token_id: TOKEN,
      owner_user_id: OWNER,
      scopes: ["doc:read", "workspace:read"],
      acting_as: null,
    });
    // The presented secret is hashed before lookup — never queried raw.
    expect(resolveAgentToken).toHaveBeenCalledWith(hashAgentToken(LIVE_TOKEN));
    expect(cookieResolve).not.toHaveBeenCalled();
  });

  it("401s an unknown agent Bearer WITHOUT falling back to the cookie", async () => {
    const resolveAgentToken = vi.fn(async () => null); // token resolves to nothing
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    const res = await app.request("/probe", {
      headers: { authorization: `Bearer ${LIVE_TOKEN}` },
    });

    expect(res.status).toBe(401);
    expect(resolveAgentToken).toHaveBeenCalledOnce();
    expect(cookieResolve).not.toHaveBeenCalled();
  });

  it("401s a non-ez_agent_ Bearer with no DB round-trip and no cookie fallback", async () => {
    const resolveAgentToken = vi.fn(async () => LIVE_RESOLUTION);
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    const res = await app.request("/probe", {
      headers: { authorization: "Bearer some-other-bearer-token" },
    });

    expect(res.status).toBe(401);
    expect(resolveAgentToken).not.toHaveBeenCalled();
    expect(cookieResolve).not.toHaveBeenCalled();
  });

  it("401s a malformed ez_agent_ Bearer (wrong length) without hashing or a DB hit", async () => {
    const resolveAgentToken = vi.fn(async () => LIVE_RESOLUTION);
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    // Right prefix, far too few body chars — fails the shape gate before
    // any hash or unique-index probe.
    const res = await app.request("/probe", {
      headers: { authorization: "Bearer ez_agent_short" },
    });

    expect(res.status).toBe(401);
    expect(resolveAgentToken).not.toHaveBeenCalled();
    expect(cookieResolve).not.toHaveBeenCalled();
  });

  it("401s a malformed ez_agent_ Bearer (non-base62 body) without hashing or a DB hit", async () => {
    const resolveAgentToken = vi.fn(async () => LIVE_RESOLUTION);
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    // 43 chars but a '-' in the body (base62 excludes it).
    const res = await app.request("/probe", {
      headers: { authorization: `Bearer ez_agent_${"A".repeat(42)}-` },
    });

    expect(res.status).toBe(401);
    expect(resolveAgentToken).not.toHaveBeenCalled();
    expect(cookieResolve).not.toHaveBeenCalled();
  });

  it("lets the Bearer win when a cookie is ALSO present", async () => {
    const resolveAgentToken = vi.fn(async () => LIVE_RESOLUTION);
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    const res = await app.request("/probe", {
      headers: {
        authorization: `Bearer ${LIVE_TOKEN}`,
        cookie: "better-auth.session_token=abc",
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("agent");
    expect(cookieResolve).not.toHaveBeenCalled();
  });

  it("matches the Bearer scheme case-insensitively (RFC 6750)", async () => {
    const resolveAgentToken = vi.fn(async () => LIVE_RESOLUTION);
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    const res = await app.request("/probe", {
      headers: { authorization: `bearer ${LIVE_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("agent");
  });

  it("defers a non-Bearer Authorization (Basic) to the cookie resolver", async () => {
    const resolveAgentToken = vi.fn(async () => LIVE_RESOLUTION);
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    const res = await app.request("/probe", {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("user");
    expect(cookieResolve).toHaveBeenCalledOnce();
    expect(resolveAgentToken).not.toHaveBeenCalled();
  });

  it("surfaces corrupt stored scopes as a 500 (parser throws), not a silent 401", async () => {
    const resolveAgentToken = vi.fn(async () => ({
      ...LIVE_RESOLUTION,
      scopes: JSON.stringify(["doc:read", "not-a-real-scope"]),
    }));
    const cookieResolve = vi.fn(async () => COOKIE_USER);
    const app = buildProbeApp({ resolveAgentToken, cookieResolve });

    const res = await app.request("/probe", {
      headers: { authorization: `Bearer ${LIVE_TOKEN}` },
    });

    expect(res.status).toBe(500);
  });
});
