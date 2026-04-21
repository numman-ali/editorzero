/**
 * Minimal-app test for `POST /docs/update/:doc_id` (ADR 0021 §Per-route
 * test posture). Mirror of `rename.unit.test.ts`: mounts only this
 * route on a fresh `OpenAPIHono<ApiEnv>` with a fixture middleware
 * chain that seeds `c.var.principal` + `c.var.dispatcher`.
 *
 * **What this test owns.**
 *   1. Dispatches `doc.update` with `capability_id: "doc.update"`, the
 *      principal off `c.var`, and `access.workspace_id` from the
 *      principal.
 *   2. Merges the path-param `doc_id` with the body `{ ops }` into the
 *      dispatcher input.
 *   3. Returns the dispatcher's output via `c.json` with status 200.
 *   4. Invalid path param → 400 pre-dispatcher.
 *   5. Invalid body (empty ops / unknown discriminator / strict key
 *      violation / bad hash shape) → 400 pre-dispatcher.
 *
 * **What this test does NOT own.** Dispatcher pipeline (parse → gate →
 * audit), the actual CRDT write-path tx, session-cookie roundtrip —
 * those live in `capabilities/doc/update.unit.test.ts` and
 * `composition/auth-chain.integration.test.ts`.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { update } from "./update";

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

interface FixtureAppliedOp {
  readonly op: "update";
  readonly block_id: string;
  readonly post: {
    readonly id: string;
    readonly doc_id: string;
    readonly type: string;
    readonly parent_block_id: string | null;
    readonly order_key: string;
    readonly content_json: unknown;
    readonly visibility: "default" | "internal" | "public";
  };
}

interface FixtureOutput {
  readonly doc_id: string;
  readonly applied_ops: readonly FixtureAppliedOp[];
  readonly updated_at: number;
}

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new OpenAPIHono<ApiEnv>();
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
  app.openapiRoutes([update] as const);
  return app;
}

describe("POST /docs/update/:doc_id", () => {
  it("dispatches doc.update with path+body merged into input, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      doc_id: VALID_DOC_ID,
      applied_ops: [
        {
          op: "update",
          block_id: VALID_BLOCK_ID,
          post: {
            id: VALID_BLOCK_ID,
            doc_id: VALID_DOC_ID,
            type: "paragraph",
            parent_block_id: null,
            order_key: "000001",
            content_json: { content: "New body" },
            visibility: "default",
          },
        },
      ],
      updated_at: 2_000_000,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const ops = [{ op: "update", block_id: VALID_BLOCK_ID, patch: { content: "New body" } }];
    const res = await app.request(`/docs/update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("doc.update"));
    expect(captured?.input).toEqual({ doc_id: VALID_DOC_ID, ops });
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("non-UUID doc_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const res = await app.request("/docs/update/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [] }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("UUID-v4 doc_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const v4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const res = await app.request(`/docs/update/${v4}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "update", block_id: VALID_BLOCK_ID, patch: { content: "x" } }],
      }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("empty ops array → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [] }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("unknown op discriminator (e.g. 'move') → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "move", block_id: VALID_BLOCK_ID, new_order_key: "a0" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("bad expect_prior_content_hash shape → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "update",
            block_id: VALID_BLOCK_ID,
            patch: { content: "x" },
            expect_prior_content_hash: "abc123", // too short
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("empty update patch (no-op) → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on empty patch");
    });

    const res = await app.request(`/docs/update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "update", block_id: VALID_BLOCK_ID, patch: {} }],
      }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("unknown op-level key → 400 before the dispatcher runs (strict)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/update/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "update",
            block_id: VALID_BLOCK_ID,
            patch: { content: "x" },
            extra_field: "should not pass",
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
