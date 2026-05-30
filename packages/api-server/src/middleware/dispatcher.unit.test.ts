/**
 * `createDispatcherMiddleware` — unit test.
 *
 * Confirms the middleware sets `c.var.dispatcher` to exactly the
 * value passed in. Uses a stub dispatcher (just a typed object)
 * because the middleware's only job is value-propagation; it does
 * not call `dispatcher.dispatch` itself.
 */

import type { Dispatcher } from "@editorzero/dispatcher";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../env";
import { createDispatcherMiddleware } from "./dispatcher";

describe("createDispatcherMiddleware", () => {
  it("attaches the injected dispatcher to c.var.dispatcher", async () => {
    let captured: Dispatcher | undefined;
    const stubDispatcher = {
      dispatch: async () => ({}),
      deps: {},
    } as unknown as Dispatcher;

    const app = new Hono<ApiEnv>();
    app.use("*", createDispatcherMiddleware({ dispatcher: stubDispatcher }));
    app.get("/probe", (c) => {
      captured = c.var.dispatcher;
      return c.json({ ok: true });
    });

    const res = await app.request("/probe");
    expect(res.status).toBe(200);
    expect(captured).toBe(stubDispatcher);
  });
});
