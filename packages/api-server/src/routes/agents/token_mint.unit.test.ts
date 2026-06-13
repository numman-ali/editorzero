/**
 * Minimal-app test for `POST /agents/token_mint/:agent_id` (ADR 0021
 * §Per-route test posture; ADR 0029 code-first shape). P3 split —
 * param carries `agent_id`, body carries `{tier, scopes?, expires_at?}`.
 * The 200 body is the one place the show-once `token` secret rides;
 * this suite pins that it flows through the output re-parse intact.
 * Tier↔scopes ambiguity and non-amplification live in the capability
 * suite (the Body validator is a wire-shape gate; the dispatcher
 * re-validates the merged input through the full refined schema).
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { tokenMint } from "./token_mint";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["admin"],
  session_id: null,
  token_id: null,
};

const VALID_AGENT_ID = "018f0000-0000-7000-8000-0000000000a7";
const SECRET = `ez_agent_${"A".repeat(43)}`;

const MINT_OUTPUT = {
  token_id: "018f0000-0000-7000-8000-0000000000c3",
  workspace_id: TEST_PRINCIPAL.workspace_id,
  agent_id: VALID_AGENT_ID,
  token_prefix: SECRET.slice(0, 12),
  last4: SECRET.slice(-4),
  scopes: ["workspace:read", "doc:read"],
  tier: "custom",
  created_by: TEST_PRINCIPAL.id,
  created_at: 1,
  expires_at: null,
  revoked_at: null,
  token: SECRET,
};

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new Hono<ApiEnv>();
  const fakeDispatcher = {
    dispatch,
    // biome-ignore lint/suspicious/noExplicitAny: `deps` is not read by the route.
    deps: {} as any,
  } as Dispatcher;
  app.use("*", async (c, next) => {
    c.set("principal", TEST_PRINCIPAL);
    c.set("dispatcher", fakeDispatcher);
    await next();
  });
  app.route("/agents", tokenMint);
  return app;
}

describe("POST /agents/token_mint/:agent_id", () => {
  it("merges param + body into the capability input; the show-once token survives the echo", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return MINT_OUTPUT;
    });

    const res = await app.request(`/agents/token_mint/${VALID_AGENT_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "custom", scopes: ["workspace:read", "doc:read"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MINT_OUTPUT);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("agent.token_mint"));
    expect(captured?.input).toEqual({
      agent_id: VALID_AGENT_ID,
      tier: "custom",
      scopes: ["workspace:read", "doc:read"],
      // The Body schema's `.default(null)` materializes the absent field.
      expires_at: null,
    });
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("non-UUID agent_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const res = await app.request("/agents/token_mint/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "author" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("unknown tier → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/agents/token_mint/${VALID_AGENT_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "root" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("literal admin scope → 400 at the wire (schema half of non-amplification)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/agents/token_mint/${VALID_AGENT_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "custom", scopes: ["admin"] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
