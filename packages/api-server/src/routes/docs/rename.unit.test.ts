/**
 * Minimal-app test for `POST /docs/rename/:doc_id` (ADR 0021 §Per-route
 * test posture; ADR 0029 code-first shape). Mirrors the golden
 * `create.unit.test.ts`: mounts only this route's `Hono<ApiEnv>`
 * sub-app at `/docs` on a fresh trunk + a fixture middleware that seeds
 * `c.var.principal` + `c.var.dispatcher`.
 *
 * **What this test owns.** The route's own contract:
 *   1. It dispatches `doc.rename` with `capability_id: "doc.rename"`,
 *      the principal off `c.var`, and an `access.workspace_id`
 *      derived from the principal.
 *   2. It merges the path-param `doc_id` with the body `title` into
 *      a single dispatcher input object.
 *   3. It returns the dispatcher's output via `c.json` with status
 *      200 — rename mutates an existing doc, no 201.
 *   4. Invalid path param (non-UUID v7) → 400 before the dispatcher
 *      runs (route-level zod validation).
 *   5. Empty / whitespace-only title → 400 before the dispatcher
 *      runs.
 *
 * **What this test does NOT own.** The content-mutation write-path
 * tx (covered by the dispatcher + capability tests) and the full
 * session-cookie roundtrip through Better Auth (covered by
 * `composition/auth-chain.integration.test.ts`).
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { rename } from "./rename";

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
  readonly title: string;
  readonly slug: string;
  readonly updated_at: number;
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
  app.route("/docs", rename);
  return app;
}

describe("POST /docs/rename/:doc_id", () => {
  it("dispatches doc.rename with path+body merged into input, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      doc_id: VALID_DOC_ID,
      title: "Renamed",
      slug: "renamed",
      updated_at: 2_000_000,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/docs/rename/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("doc.rename"));
    expect(captured?.input).toEqual({ doc_id: VALID_DOC_ID, title: "Renamed" });
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

    const res = await app.request("/docs/rename/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("UUID-v4 doc_id (wrong version) → 400 before the dispatcher runs", async () => {
    // Regression guard mirror of publish.unit.test.ts — without
    // `z.uuid({ version: "v7" })` the route would accept any UUID
    // and let the capability's stricter parse produce an inscrutable
    // 500.
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const v4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const res = await app.request(`/docs/rename/${v4}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("empty title → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/rename/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("whitespace-only title → 400 before the dispatcher runs (trim + min(1))", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/docs/rename/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
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

    const res = await app.request(`/docs/rename/${VALID_DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed", slug: "manual" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
