/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

import { reservedPrefixDenylist } from "./lib/sw-denylist";

/**
 * The hand-authored service worker (ADR 0039 §1 — `injectManifest`, NOT
 * `generateSW`: this exclusion boundary is load-bearing and must be
 * explicit and auditable).
 *
 * What this SW does — and deliberately does not do:
 *
 *   - **Precache the app shell ONLY** (`self.__WB_MANIFEST` = index.html
 *     + hashed js/css/latin fonts/icons, per the vite.config glob).
 *   - **Serve client-route navigations from the cached shell** via a
 *     `NavigationRoute` whose denylist is DERIVED from the ADR 0035 §2
 *     reserved-prefix SSOT (`lib/sw-denylist.ts`). A trunk-owned path
 *     (`/auth/…`, `/docs/…`, `/infra/health`) is never answered from
 *     cache — offline it fails like the network failure it is.
 *   - **No runtimeCaching at all.** Authenticated JSON and `/auth`
 *     responses are NetworkOnly by OMISSION — stale auth/data served
 *     from a cache is a correctness bug, not a resilience feature
 *     (ADR 0039: offline-READ of the shell is the v1 promise;
 *     offline-WRITE is hard-gated behind invariants 3 + 5).
 *   - **No navigation preload** — wasted work with a precached shell.
 *   - **Updates wait for the user.** `registerType: 'prompt'`: the new
 *     SW idles in `waiting` until the update toast's reload button
 *     posts SKIP_WAITING (a live editor must never be hot-swapped over
 *     unsynced state). `clientsClaim()` only matters at activation —
 *     which this listener gates — plus first-install, where claiming
 *     immediately is harmless (there is no older content to swap out).
 *   - The collab WebSocket needs no entry here: a SW `fetch` event
 *     never intercepts ws:// upgrades (WHATWG Fetch, fetch-event scope).
 *   - **No telemetry from inside the SW** (ADR 0019: the SW is outside
 *     the OTel span context — lifecycle events are logged app-side by
 *     the `useRegisterSW` callbacks in `components/pwa-prompt.tsx`).
 */

// Module-scoped redeclaration (the vite-plugin-pwa documented pattern):
// inside this module `self` is the worker scope, not the DOM `Window`
// the app-wide tsconfig lib implies. A declaration, not a cast.
declare let self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: reservedPrefixDenylist(),
  }),
);

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

clientsClaim();
