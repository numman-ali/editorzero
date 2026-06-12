import { expect, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { TRUNK_ORIGIN } from "./servers";

/**
 * The PWA layer (ADR 0039 §1), proven against the PRODUCTION posture:
 * these specs run on the TRUNK origin, where the built SPA — service
 * worker, manifest, precache — is statically attached (ADR 0027/0035).
 * The Vite dev origin the other specs use never registers a SW (the
 * register hook is the plugin's dev no-op), so nothing here can be
 * proven there.
 *
 * This file is also the ADR 0039 Rolldown smoke: a registered SW whose
 * precache holds the hashed shell assets means `vite-plugin-pwa`'s
 * manifest injection + precache hashing survived the Vite 8 / Rolldown
 * build — exactly the integration the ADR flagged to verify before
 * relying on it.
 *
 * Playwright caveats honoured (ADR 0039 pins): `context.setOffline`
 * does not reliably fail SW-*served* requests (#2311) — so offline
 * assertions check served UI STATE for cache-served navigations, and
 * use a denylisted (never SW-served) fetch for the network-only proof.
 */

/** Navigate, then wait for the SW to register, activate, and claim. */
async function gotoWithActiveSw(page: import("@playwright/test").Page, url: string): Promise<void> {
  await page.goto(url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

test("the trunk serves the manifest and the service worker activates with the shell precached", async ({
  page,
}) => {
  await gotoWithActiveSw(page, `${TRUNK_ORIGIN}/login`);

  // Manifest link injected at build; the manifest itself is trunk-served.
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBe("/manifest.webmanifest");
  const manifest = await page.request.get(`${TRUNK_ORIGIN}/manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  const manifestBody = await manifest.json();
  expect(manifestBody.display).toBe("standalone");
  expect(manifestBody.icons).toHaveLength(3);

  // Precache contents = the Rolldown smoke: index.html + hashed assets
  // landed in the injected manifest and were fetched into the cache.
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const precacheKey = keys.find((key) => key.includes("precache"));
    if (precacheKey === undefined) return { precacheKey: null, urls: [] };
    const cache = await caches.open(precacheKey);
    const requests = await cache.keys();
    return { precacheKey, urls: requests.map((request) => new URL(request.url).pathname) };
  });
  expect(cached.precacheKey).not.toBeNull();
  expect(cached.urls.some((url) => url.includes("index.html"))).toBe(true);
  expect(cached.urls.some((url) => url.startsWith("/assets/") && url.endsWith(".js"))).toBe(true);
  expect(cached.urls.some((url) => url.endsWith(".woff2"))).toBe(true);
  expect(cached.urls.some((url) => url.startsWith("/icons/"))).toBe(true);
});

test("reserved prefixes stay network-only and the shell serves offline (denylist behavior)", async ({
  page,
  context,
}) => {
  await gotoWithActiveSw(page, `${TRUNK_ORIGIN}/login`);
  // Ensure this page itself is SW-controlled before going offline.
  await page.reload();
  await expect(page.locator('input[name="email"]')).toBeVisible();

  // Online + SW-controlled: a reserved-prefix fetch reaches the trunk.
  const online = await page.evaluate(async () => {
    const res = await fetch("/infra/health");
    return { ok: res.ok, body: await res.json() };
  });
  expect(online.ok).toBe(true);
  expect(online.body.status).toBe("ok");

  await context.setOffline(true);
  try {
    // The denylist gave `/infra/*` no SW route — offline it fails like
    // the network failure it is (nothing cached to lie with). A SW that
    // served the shell here would be the ADR's security-relevant drift.
    const offlineReserved = await page.evaluate(async () => {
      try {
        await fetch("/infra/health");
        return "served";
      } catch {
        return "network-error";
      }
    });
    expect(offlineReserved).toBe("network-error");

    // Client-route navigation offline: served from the precached shell —
    // asserted as UI state (the login form renders), per the Playwright
    // setOffline caveat.
    await page.goto(`${TRUNK_ORIGIN}/login`);
    await expect(page.locator('input[name="email"]')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("a reserved-prefix NAVIGATION is never answered with the app shell", async ({ page }) => {
  await gotoWithActiveSw(page, `${TRUNK_ORIGIN}/login`);
  // Navigate the tab itself to a trunk-owned path: the denylist must let
  // it through to the network even though a navigation is exactly what
  // the shell fallback exists for.
  const response = await page.goto(`${TRUNK_ORIGIN}/infra/health`);
  expect(response?.ok()).toBe(true);
  const contentType = response?.headers()["content-type"] ?? "";
  expect(contentType.includes("application/json")).toBe(true);
  await expect(page.locator("#root")).toHaveCount(0);
});

test("the PWA chrome passes axe on the production-served login", async ({ page }) => {
  await gotoWithActiveSw(page, `${TRUNK_ORIGIN}/login`);
  // The offline-ready toast may be up (role=status) — scan WITH it.
  await expectNoAxeViolations(page);
});
