/**
 * Minimal-app test for `POST /docs/publish/:doc_id` (ADR 0021 §Per-route
 * test posture; ADR 0029 code-first shape). Mirrors
 * `routes/docs/create.unit.test.ts`: mounts only this route's
 * `Hono<ApiEnv>` sub-app at `/docs` on a fresh trunk + a fixture
 * middleware that seeds `c.var.principal` + `c.var.dispatcher`.
 *
 * **What this test owns.** The route's own contract:
 *   1. It dispatches `doc.publish` with `capability_id: "doc.publish"`,
 *      the principal off `c.var`, and an `access.workspace_id` derived
 *      from the principal.
 *   2. It forwards the path-param `doc_id` as `input.doc_id` to the
 *      dispatcher (no request body).
 *   3. It returns the dispatcher's output through `c.json` with status
 *      200 (not 201 — publish mutates an existing doc, doesn't create).
 *   4. Invalid path param (non-UUID v7) → 400 without invoking the
 *      dispatcher (the validator + hook reject before the handler).
 *
 * **What this test does NOT own.** The metadata-only write-path tx
 * (covered by the dispatcher's integration tests + the capability's
 * own unit test) and the full request-auth-cookie roundtrip (covered
 * by `composition/auth-chain.integration.test.ts`).
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { publish } from "./publish";

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
  readonly published_slug: string;
  readonly published_at: number;
  readonly render_version: number;
}

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new Hono<ApiEnv>();
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
  app.route("/docs", publish);
  return app;
}

describe("POST /docs/publish/:doc_id", () => {
  it("dispatches doc.publish with path-param doc_id + principal-derived access, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      doc_id: VALID_DOC_ID,
      published_slug: "minted-slug",
      published_at: 2_000_000,
      render_version: 4,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/docs/publish/${VALID_DOC_ID}`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("doc.publish"));
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

    const res = await app.request("/docs/publish/not-a-uuid", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("UUID-v4 doc_id (wrong version) → 400 before the dispatcher runs", async () => {
    // `DocIdInputSchema` accepts only v7; a well-formed v4 must still
    // fail. Mirror of the get/index.unit.test.ts regression guard —
    // without it the route accepts any uuid and lets the capability's
    // stricter parse produce an inscrutable 500.
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const v4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const res = await app.request(`/docs/publish/${v4}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
