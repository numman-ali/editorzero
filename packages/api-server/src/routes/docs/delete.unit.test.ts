/**
 * Minimal-app test for `POST /docs/delete/:doc_id`. Mirrors
 * `routes/docs/{publish,unpublish}.unit.test.ts`.
 *
 * **What this test owns.**
 *   1. Dispatches `doc.delete` with the capability id, principal from
 *      `c.var`, and principal-derived `access.workspace_id`.
 *   2. Forwards path-param `doc_id` as `input.doc_id`.
 *   3. Returns the dispatcher's output through `c.json` with status 200.
 *   4. Invalid path param (non-UUID v7) → 400 without invoking the
 *      dispatcher (zod validation happens before the handler).
 *
 * **What this test does NOT own.** Metadata-only write-path tx
 * (dispatcher integration tests) and full auth-cookie roundtrip
 * (`composition/auth-chain.integration.test.ts`).
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { del } from "./delete";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

const VALID_DOC_ID = "018f0000-0000-7000-8000-0000000000a1";

interface FixtureOutput {
  readonly doc_id: string;
  readonly deleted_at: number;
  readonly visibility_version: number;
}

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new OpenAPIHono<ApiEnv>();
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
  app.openapiRoutes([del] as const);
  return app;
}

describe("POST /docs/delete/:doc_id", () => {
  it("dispatches doc.delete with path-param doc_id + principal-derived access, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      doc_id: VALID_DOC_ID,
      deleted_at: 2_000_000,
      visibility_version: 7,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/docs/delete/${VALID_DOC_ID}`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("doc.delete"));
    expect(captured?.input).toEqual({ doc_id: VALID_DOC_ID });
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

    const res = await app.request("/docs/delete/not-a-uuid", { method: "POST" });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("UUID-v4 doc_id (wrong version) → 400 before the dispatcher runs", async () => {
    // Same version-narrowing regression guard as publish/unpublish/get:
    // a well-formed v4 UUID must still fail because the route's
    // `z.uuid({ version: "v7" })` constraint forbids it.
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const v4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const res = await app.request(`/docs/delete/${v4}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
