/**
 * `attachSpa` integration test — the production static attach (ADR
 * 0027/0035) against a real booted trunk and a real dist directory on
 * disk (absolute root — pinning that the pinned `@hono/node-server`
 * `serveStatic` accepts absolute paths, which its doc comment is
 * ambiguous about).
 *
 * The contract under test, in order of how much it matters:
 *
 *   1. Reserved prefixes NEVER fall back to HTML — an unmatched API path
 *      stays the trunk's own (JSON/text) 404, an auth-gated route stays
 *      401. This is the guard that keeps API errors machine-readable.
 *   2. Client routes deep-link: GET /login (no such file) serves
 *      index.html so a hard refresh inside the SPA works.
 *   3. Hashed assets are immutable; the shell is no-cache.
 *   4. The fallback is GET-only and traversal requests never escape the
 *      dist root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type BootedApp, getApiApp } from "@editorzero/api-server";
import { parseRuntimeConfig } from "@editorzero/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attachSpa, cacheControlFor } from "./spa";

const TEST_SECRET = "test-secret-do-not-use-in-production-appsserver";

const INDEX_HTML = "<!doctype html><html><body>editorzero shell</body></html>";
const ASSET_JS = "console.log('hashed asset');";

describe("attachSpa", () => {
  let booted: BootedApp;
  let distRoot: string;

  beforeAll(async () => {
    distRoot = mkdtempSync(path.join(tmpdir(), "ez-spa-dist-"));
    writeFileSync(path.join(distRoot, "index.html"), INDEX_HTML);
    writeFileSync(path.join(distRoot, "favicon.svg"), "<svg></svg>");
    mkdirSync(path.join(distRoot, "assets"));
    writeFileSync(path.join(distRoot, "assets", "app-C4fe1Sta.js"), ASSET_JS);

    booted = await getApiApp({
      config: parseRuntimeConfig({
        EDITORZERO_PUBLIC_ORIGIN: "http://localhost:3000",
        DATABASE_URL: ":memory:",
      }),
      secret: TEST_SECRET,
    });
    attachSpa(booted.app, distRoot);
  });

  afterAll(async () => {
    await booted.close();
    rmSync(distRoot, { recursive: true, force: true });
  });

  function get(pathname: string, init?: RequestInit): Promise<Response> {
    return Promise.resolve(booted.app.request(pathname, init));
  }

  it("serves the shell at / with no-cache (directory → index.html)", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("falls back to the shell for a client route (deep link / hard refresh)", async () => {
    const res = await get("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("serves hashed assets with the immutable cache header", async () => {
    const res = await get("/assets/app-C4fe1Sta.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe(ASSET_JS);
  });

  it("serves root-level static files without the immutable header", async () => {
    const res = await get("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("keeps API routes first: /infra/health stays JSON", async () => {
    const res = await get("/infra/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("keeps auth-gated API responses: an unauthenticated /docs path stays a JSON 401, never HTML", async () => {
    // The docs domain's auth middleware fires for the whole prefix (the
    // list route itself lives at /docs/list); either way the reserved
    // prefix must answer in the API's vocabulary, not the shell's.
    const res = await get("/docs");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("NEVER serves the shell under a reserved prefix (unmatched API path)", async () => {
    // No such route in the trunk; without the guard this would 200 with HTML.
    const res = await get("/docs/no/such/route");
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    const body = await res.text();
    expect(body).not.toContain("editorzero shell");
  });

  it("does not answer non-GET requests with the shell", async () => {
    const res = await get("/login", { method: "POST" });
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(res.status).toBe(404);
  });

  it("rejects path traversal out of the dist root", async () => {
    // serveStatic refuses `..` segments pre-fs; the fallback then serves the
    // shell (harmless — fixed file, not the traversal target).
    const res = await get("/assets/%2e%2e/%2e%2e/etc/passwd");
    const body = await res.text();
    expect(body).not.toContain("root:");
  });

  it("cacheControlFor splits hashed assets from stable-name files", () => {
    expect(cacheControlFor("/assets/app-abc.js")).toContain("immutable");
    expect(cacheControlFor("/index.html")).toBe("no-cache");
    expect(cacheControlFor("/login")).toBe("no-cache");
  });
});
