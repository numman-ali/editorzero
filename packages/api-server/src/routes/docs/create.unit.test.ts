/**
 * Minimal-app test for `POST /docs/create` (ADR 0021 §Per-route test
 * posture; ADR 0029 code-first shape). Mounts only this route's
 * `Hono<ApiEnv>` sub-app at `/docs` on a fresh trunk + a fixture
 * middleware that seeds `c.var.principal` + `c.var.dispatcher`.
 *
 * **What this test owns.** The route's own contract:
 *   1. It dispatches `doc.create` with `capability_id: "doc.create"`,
 *      the principal off `c.var`, and an `access.workspace_id` derived
 *      from the principal.
 *   2. It forwards the parsed body as `input` to the dispatcher.
 *   3. It returns the dispatcher's output through `c.json` with 201.
 *   4. Invalid body (empty title / unknown key) → 400 without invoking
 *      the dispatcher (the validator + hook reject before the handler).
 *
 * **What this test does NOT own.** The dispatcher's write-path
 * (`ctx.transact`, persistence, rollback) — that's
 * `composition/createApiDispatcher.integration.test.ts`. The full
 * request-auth-cookie roundtrip — `composition/auth-chain.integration.test.ts`.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { create } from "./create";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

interface FixtureOutput {
  readonly doc_id: string;
  readonly workspace_id: string;
  readonly collection_id: string | null;
  readonly title: string;
  readonly slug: string;
  readonly order_key: string;
  readonly created_by: string;
  readonly access_mode: "space" | "private";
  readonly published_slug: null;
  readonly published_at: null;
  readonly seed_blocks: ReadonlyArray<{
    id: string;
    type: string;
    props?: Record<string, unknown>;
    content?: unknown;
  }>;
}

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
  app.route("/docs", create);
  return app;
}

describe("POST /docs/create", () => {
  it("dispatches doc.create with parsed body + principal-derived access, returns 201 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      doc_id: "018f0000-0000-7000-8000-0000000000a1",
      workspace_id: TEST_PRINCIPAL.workspace_id,
      collection_id: null,
      title: "Hello",
      slug: "hello",
      order_key: "018f0000-0000-7000-8000-0000000000a1",
      created_by: TEST_PRINCIPAL.id,
      access_mode: "space",
      published_slug: null,
      published_at: null,
      seed_blocks: [
        { id: "018f0000-0000-7000-8000-0000000000b1", type: "heading", props: { level: 1 } },
        { id: "018f0000-0000-7000-8000-0000000000b2", type: "paragraph" },
      ],
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/docs/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("doc.create"));
    expect(captured?.input).toEqual({ title: "Hello" });
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("empty title → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request("/docs/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("unrecognized keys → 400 (input schema is .strict)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request("/docs/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `access_mode` is the key a tempted client would send post-Step-5
      // (read scope is not caller-settable); `visibility` is the retired
      // pre-Step-5 vocabulary — both must 400, not silently drop.
      body: JSON.stringify({ title: "Hello", access_mode: "private", visibility: "public" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
