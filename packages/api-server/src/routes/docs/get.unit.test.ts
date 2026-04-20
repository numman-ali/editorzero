/**
 * Minimal-app test for `GET /docs/get/:doc_id` (ADR 0021 §Per-route
 * test posture). Mirrors `routes/docs/{list,create}.unit.test.ts`:
 * mounts only this route on a fresh `OpenAPIHono<ApiEnv>` + a fixture
 * middleware chain that seeds `c.var.principal` + `c.var.dispatcher`.
 *
 * **What this test owns.** The route's own contract:
 *   1. It dispatches `doc.get` with `capability_id: "doc.get"`,
 *      the principal off `c.var`, and an `access.workspace_id`
 *      derived from the principal.
 *   2. It forwards the path-param `doc_id` as `input.doc_id` to the
 *      dispatcher.
 *   3. It returns the dispatcher's output through `c.json` with
 *      status 200.
 *   4. Invalid path param (non-UUID v7) → 400 without invoking the
 *      dispatcher (zod validation happens before the handler).
 *
 * **What this test does NOT own.** The `ctx.transact` → `sync.read`
 * wiring (covered by `composition/createApiDispatcher.integration
 * .test.ts` + `packages/sync/src/hocuspocus.integration.test.ts`)
 * and the full request-auth-cookie roundtrip (covered by
 * `composition/auth-chain.integration.test.ts`).
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { get } from "./get";

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
  readonly doc: {
    id: string;
    workspace_id: string;
    title: string;
    slug: string;
    collection_id: string | null;
    visibility: "workspace" | "public" | "private";
    created_at: number;
    updated_at: number;
  };
  readonly blocks: ReadonlyArray<unknown>;
}

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new OpenAPIHono<ApiEnv>();
  const fakeDispatcher = {
    dispatch,
    // biome-ignore lint/suspicious/noExplicitAny: `deps` is not read by the route; see list/index.unit.test.ts.
    deps: {} as any,
  } as Dispatcher;
  app.use("*", async (c, next) => {
    c.set("principal", TEST_PRINCIPAL);
    c.set("dispatcher", fakeDispatcher);
    await next();
  });
  app.openapiRoutes([get] as const);
  return app;
}

describe("GET /docs/get/:doc_id", () => {
  it("dispatches doc.get with path-param doc_id + principal-derived access, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      doc: {
        id: VALID_DOC_ID,
        workspace_id: TEST_PRINCIPAL.workspace_id,
        title: "Hello",
        slug: "hello",
        collection_id: null,
        visibility: "workspace",
        created_at: 1,
        updated_at: 1,
      },
      blocks: [
        { id: "018f0000-0000-7000-8000-0000000000b1", type: "heading", props: { level: 1 } },
        { id: "018f0000-0000-7000-8000-0000000000b2", type: "paragraph" },
      ],
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/docs/get/${VALID_DOC_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("doc.get"));
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

    const res = await app.request("/docs/get/not-a-uuid");
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("UUID-v4 doc_id (wrong version) → 400 before the dispatcher runs", async () => {
    // `z.uuid({ version: "v7" })` accepts only v7; a well-formed v4
    // must still fail. Regression guard on the version narrowing —
    // without it, the route would accept any uuid shape and let the
    // capability's stricter parse produce an inscrutable 500 instead
    // of the clean 400 the API contract promises.
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const v4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const res = await app.request(`/docs/get/${v4}`);
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
