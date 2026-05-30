/**
 * Per-route test — isolated from the trunk (ADR 0021 §Per-route test
 * posture; ADR 0029 code-first shape).
 *
 * Mounts only this route's `Hono<ApiEnv>` sub-app at `/infra` on a fresh
 * trunk and exercises it via `app.request(...)`. Deliberately does not
 * import the trunk `app` — the route's behaviour (response shape, status
 * code) is a separate concern from trunk composition. A trunk regression
 * should not cascade into every route test; that cleanly separates "my
 * route's contract" from "the trunk glues routes together".
 *
 * **No fixture middleware.** `/infra/health` is public infrastructure —
 * no capability, no dispatcher, no principal — so there is nothing to
 * seed onto `c.var` (contrast the capability-route tests, which seed
 * `c.var.principal` + `c.var.dispatcher`).
 *
 * **What the trunk smoke covers instead.** Multi-route OpenAPI doc
 * generation and the `hc<AppType>`-via-`app.request` server-to-server
 * path. Those live in `src/app.unit.test.ts`.
 *
 * **What an integration test would cover later.** Real dispatcher + DB +
 * auth middleware chain end-to-end. Those land under `test/integration/`
 * when those slices exist.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { health } from "./health";

function buildApp() {
  const app = new Hono<ApiEnv>();
  app.route("/infra", health);
  return app;
}

describe("GET /infra/health", () => {
  it("returns { status: 'ok', now: <number> }", async () => {
    const app = buildApp();
    const res = await app.request("/infra/health", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; now: number };
    expect(body.status).toBe("ok");
    expect(typeof body.now).toBe("number");
  });

  it("now is populated with a plausibly-current epoch-ms value", async () => {
    // Guards against the probe accidentally returning a frozen constant
    // or a stringified date. Tolerates ±60s clock skew; the point is
    // "this came from Date.now() this second", not hermetic precision.
    const app = buildApp();
    const before = Date.now();
    const res = await app.request("/infra/health", { method: "GET" });
    const body = (await res.json()) as { status: string; now: number };
    const after = Date.now();
    expect(body.now).toBeGreaterThanOrEqual(before - 60_000);
    expect(body.now).toBeLessThanOrEqual(after + 60_000);
  });
});
