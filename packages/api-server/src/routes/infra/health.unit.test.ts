/**
 * Per-route test — isolated from the trunk.
 *
 * Mounts only this route on a fresh `OpenAPIHono<ApiEnv>` and exercises
 * it via `testClient`. Deliberately does not import the trunk `app` —
 * the route's behaviour (response shape, status codes, zod-validated
 * input, eventually its middleware chain) is a separate concern from
 * trunk composition. A trunk regression should not cascade into every
 * route test; that cleanly separates "my route's contract" from "the
 * trunk glues routes together".
 *
 * **Minimal-app pattern.** `new OpenAPIHono<ApiEnv>().openapiRoutes(
 * [health] as const)` — the `as const` is load-bearing even for the
 * single-route case, since `openapiRoutes` uses a `const Inputs` type
 * parameter whose tuple recursion in `SchemaFromRoutes` only fires
 * against literal tuples. Without it, `testClient(isolated).infra.
 * health.$get` loses its typed-RPC binding.
 *
 * **What the trunk smoke covers instead.** Multi-route Schema merge,
 * OpenAPI doc generation, and `hc<AppType>`-via-`app.request` server-
 * to-server path. Those live in `src/app.unit.test.ts`.
 *
 * **What an integration test would cover later.** Real dispatcher +
 * DB + auth middleware chain end-to-end. Those land under
 * `test/integration/` when those slices exist.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { testClient } from "hono/testing";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { health } from "./health";

const isolated = new OpenAPIHono<ApiEnv>().openapiRoutes([health] as const);

describe("GET /infra/health", () => {
  it("returns { status: 'ok', now: <number> }", async () => {
    const client = testClient(isolated);
    const res = await client.infra.health.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.now).toBe("number");
  });

  it("now is populated with a plausibly-current epoch-ms value", async () => {
    // Guards against the probe accidentally returning a frozen constant
    // or a stringified date. Tolerates ±60s clock skew; the point is
    // "this came from Date.now() this second", not hermetic precision.
    const before = Date.now();
    const client = testClient(isolated);
    const res = await client.infra.health.$get();
    const body = await res.json();
    const after = Date.now();
    expect(body.now).toBeGreaterThanOrEqual(before - 60_000);
    expect(body.now).toBeLessThanOrEqual(after + 60_000);
  });
});
