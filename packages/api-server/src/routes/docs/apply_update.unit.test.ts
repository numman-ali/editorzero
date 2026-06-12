/**
 * Minimal-app test for `POST /docs/apply_update/:doc_id` (ADR 0021
 * §Per-route test posture; ADR 0029 code-first shape). Mirrors the
 * golden `update.unit.test.ts`: mounts only this route's `Hono<ApiEnv>`
 * sub-app at `/docs` on a fresh trunk + a fixture middleware that seeds
 * `c.var.principal` + `c.var.dispatcher`.
 *
 * **What this test owns.**
 *   1. Dispatches `doc.apply_update` with the principal off `c.var` and
 *      `access.workspace_id` from the principal.
 *   2. Merges the path-param `doc_id` with the body `{ update }` into
 *      the dispatcher input.
 *   3. Returns the dispatcher's output via `c.json` with status 200 —
 *      both the applied shape and the marked no-op.
 *   4. Invalid path param → 400 pre-dispatcher.
 *   5. Invalid body (bad alphabet / unpadded / empty / unknown keys)
 *      → 400 pre-dispatcher.
 *
 * **What this test does NOT own.** The foreign-update lane's refusal
 * matrix (sync/foreign-update.unit.test.ts), the capability composition
 * (capabilities/doc/apply_update.unit.test.ts), dispatcher pipeline.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { applyUpdate } from "./apply_update";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

const VALID_DOC_ID = "018f0000-0000-7000-8000-0000000000a1";
const VALID_BLOCK_ID = "018f0000-0000-7000-8000-00000000b001";

interface FixtureOutput {
  readonly doc_id: string;
  readonly applied: boolean;
  readonly update_b64: string | null;
  readonly minted_block_ids: readonly string[];
  readonly updated_at: number;
}

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new Hono<ApiEnv>();
  const fakeDispatcher = {
    dispatch,
    // biome-ignore lint/suspicious/noExplicitAny: `deps` is not read by the route; see rename.unit.test.ts.
    deps: {} as any,
  } as Dispatcher;
  app.use("*", async (c, next) => {
    c.set("principal", TEST_PRINCIPAL);
    c.set("dispatcher", fakeDispatcher);
    await next();
  });
  app.route("/docs", applyUpdate);
  return app;
}

describe("POST /docs/apply_update/:doc_id", () => {
  it("dispatches doc.apply_update with path+body merged into input, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      doc_id: VALID_DOC_ID,
      applied: true,
      update_b64: "UE9TVC1SRVBBSVI=",
      minted_block_ids: [VALID_BLOCK_ID],
      updated_at: 2_000_000,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/docs/apply_update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: "QUFBQQ==" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("doc.apply_update"));
    expect(captured?.input).toEqual({ doc_id: VALID_DOC_ID, update: "QUFBQQ==" });
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("passes the marked no-op output through untouched (applied: false, update_b64: null)", async () => {
    const output: FixtureOutput = {
      doc_id: VALID_DOC_ID,
      applied: false,
      update_b64: null,
      minted_block_ids: [],
      updated_at: 1_000,
    };
    const app = buildApp(async () => output);

    const res = await app.request(`/docs/apply_update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: "AAAA" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output);
  });

  it("non-UUID doc_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const res = await app.request("/docs/apply_update/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: "AAAA" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("URL-safe base64 alphabet → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/apply_update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: "AA_-" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("unpadded base64 (length % 4 !== 0) → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/apply_update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: "AAAAA" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("empty update string → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/apply_update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: "" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("unknown body key → 400 before the dispatcher runs (strict)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/apply_update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: "AAAA", origin: "ws" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
