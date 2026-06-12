# ADR 0039 — PWA, mobile & offline-CRDT stance

**Status:** Accepted (new, 2026-05-31)
**Date:** 2026-05-31
**Deciders:** @numman (*"mobile-friendly PWA … we expect people to be able to use this anywhere"*); Claude Opus 4.8 (PWA / offline determination, delegated per AGENTS.md)

## Context

Nomi wants editorzero usable anywhere: a **mobile-friendly, installable PWA**, first-class rather than a bolt-on. The SPA (ADR 0035) is served **same-origin** by the Hono trunk (ADR 0027), with real-time collaboration over embedded Hocuspocus/Yjs and same-origin `SameSite=Lax` cookie auth (ADR 0030).

A PWA *plus* a CRDT collab editor *plus* audit-complete permissioned mutations (invariants 3 and 5) raise three sharp questions: **what can a service worker safely cache**, **what does "offline" mean for a permissioned CRDT**, and **does the auth model survive inside an installed standalone app**. A research Workflow (`wf_734a602e-3d6`, Verdict 2 + memos) verified the answers against the npm registry, platform specs, and GitHub on 2026-05-31, and corrected several citations/version strings (folded in below).

## Decision

**Ship a PWA layer over the ADR 0035 SPA as pure progressive enhancement**, with three firm stances and one auth verdict.

### 1. Installable PWA — `vite-plugin-pwa`, `injectManifest`

- **`strategies: 'injectManifest'`** (hand-authored `src/sw.ts`) over `generateSW` — the exclusion boundary is load-bearing and must be explicit and auditable.
- **`registerType: 'prompt'` — NEVER `autoUpdate`.** A live-CRDT editor must not hot-swap the SW and reload over unsynced local Yjs state. Surface an *"update available"* toast (`virtual:pwa-register` `onNeedRefresh`) and honour a `SKIP_WAITING` message only on user click. `injectRegister: false` (register explicitly so order is controlled). `VitePWA()` **last** in the plugin array (after `tanstackRouter()` + react/swc — ADR 0035).
- **Precache the app shell ONLY** (`index.html` + hashed JS/CSS/font/icon). Serve navigations from the cached shell via a `NavigationRoute` whose `navigateFallbackDenylist` **excludes every trunk-owned prefix**; give those prefixes **no `runtimeCaching` entry** (pure `NetworkOnly` pass-through). **Never** `CacheFirst`/`StaleWhileRevalidate` an authenticated JSON-RPC or `/auth` response — stale auth/data is a correctness bug.
- **The denylist is derived from the SAME ADR 0035 §2 reserved-prefix SSOT** — `[/auth, /mcp, /collab, /infra, /docs, /collections, /workspaces, /audit]` — **plus a test asserting the two lists match.** Denylist drift is **security-relevant**: a dropped prefix would serve the cached app-shell HTML for an API/auth path offline (a correctness break).
- **Do NOT enable navigation preload** — wasted with a precached shell (Workbox doc, verbatim).
- **The collab WS is safe BY CONSTRUCTION:** a service worker's `fetch` event never intercepts `ws://`/`wss://` upgrades. **Cite the WHATWG Fetch spec's fetch-event scope for this — NOT W3C ServiceWorker #947** (a sparse, unresolved discussion about merely exposing WS constructors in SW scope; the conclusion is right, the earlier evidence was misattributed).
- **Manifest** from Meridian Zero tokens (`theme_color` / `background_color`, ADR 0036): stable `id` + `start_url: '/?source=pwa'`, `scope: '/'`, `display: 'standalone'`, `display_override: ['standalone','minimal-ui']`, icons at 192/512 **plus** a 512 `maskable` icon; `apple-touch-icon` + `apple-mobile-web-app-*` meta in `index.html` for iOS.
- **Install UX, two paths:** *Chromium* — capture `beforeinstallprompt`, `preventDefault()`, custom Install button → `prompt()` → `userChoice`. *iOS* — a one-time *"Add to Home Screen via Share"* hint (`beforeinstallprompt` **never** fires on iOS; all iOS browsers are WebKit), gated on not-installed detection (`navigator.standalone` / `matchMedia('(display-mode: standalone)')`).
- **Vite 8 uses the Rolldown bundler** → smoke-test `vite-plugin-pwa`'s manifest injection + precache hashing **under Rolldown** before relying on it; extend ADR 0035's pin + lockfile + cooldown posture to `vite-plugin-pwa` + all `workbox-*`.

### 2. Offline stance — **offline-READ only in v1**; offline-WRITE is a separately-gated post-Phase-4 feature

The offline-write boundary is a **hard invariant boundary, not a UX preference.** Naive offline-write (`y-indexeddb` + `HocuspocusProvider` auto-replay) would merge queued Yjs ops with **zero per-edit dispatcher calls** — silently violating **invariant 3** (exactly one audit row per mutation, committed in the *same* DB transaction as the `doc_updates` row) **and invariant 5** (server-side per-mutation permission check), and would happily apply edits from a **since-revoked principal** (*CRDTs solve convergence, not authorization*). This is grounded directly in architecture §6.4, §9.3/F31, and extends §19's existing *"always-online in v1"* disposition to human PWA clients.

- **Offline-WRITE is blocked on the SAME prerequisite as production WS-attached collab** (the ADR 0027/0018 broadcast-after-commit + dispatcher-mediated WS write path, Phase 4) **plus** a re-authorization-and-audit-on-sync mechanism that does not yet exist. A future design must **replay discrete dispatcher-mediated intents, not one merged Yjs blob.**
- **Offline-READ is safe IF** the cache was authorized at fetch time, is keyed to **principal + workspace**, and is cleared on logout / on a `4401` auth-revoked WS close.
- **`y-indexeddb` is NOT adopted in v1** (offline-read needs no local Yjs persistence). It is also unmaintained (9.0.12, last released 2023-11-02) — fails the project pinning bar. **At-rest note:** it stores doc content *unencrypted* in the origin (XSS / shared-device exposure) — weigh explicitly before ever enabling for sensitive workspaces.

### 3. Responsive / touch

- Collapse the dense 3-pane layout with **both** a **bottom tab bar** (3–5 primary destinations) **and** a Base UI `Drawer` for the collections tree; the right rail becomes a `Drawer` on phone + a **bottom sheet** for transient actions (accept/reject a suggestion). (Base UI `Drawer` is stable since 1.3.0 — swipe + snap points; ADR 0037.)
- **≥44px touch-target floor** (meets WCAG **2.5.5 Enhanced AAA**; 2.5.8 AA is 24×24). Leave inline editor/suggestion text **unpadded** — inline links are exempt from both. The EAA has been in force since 2025-06-28.
- Use Base UI **`Popover` with `openOnHover`, NOT `Tooltip`**, for any touch-reachable info affordance (Base UI `Tooltip` is disabled on touch by design).
- **Mobile editor keyboard is owned app code** (Tiptap #6571 open, no upstream fix): editor shell as a `dvh`/`svh` flex column with the toolbar a flex **child** (not `position: fixed`); `interactiveWidget: 'resizes-content'` in the viewport meta (Android); VirtualKeyboard API + `keyboard-inset-*` env vars as Chromium progressive enhancement; an rAF-guarded `visualViewport` listener as the iOS-Safari fallback (known to flicker — validate on real hardware). `dvh` **alone** will not hold a fixed bottom bar above the iOS keyboard.
- **Safe-area is hand-owned:** `viewport-fit=cover` + `env(safe-area-inset-*)` on all fixed/bottom chrome, with an explicit z-order / simultaneous-visibility spec for tab bar + bottom format bar + bottom sheet on small phones. Floating UI provides shift/flip/size but **no** virtual-keyboard or safe-area handling (ADR 0037).

### Auth verdict (the central question)

A same-origin **`SameSite=Lax` HttpOnly Secure** session cookie **persists inside an installed standalone PWA** — **ADR 0030's model holds unchanged inside the app.** The single caveat is iOS-specific: iOS does **not** hand off the Safari session to a freshly-installed PWA (separate storage partition), so first launch is signed-out → ADR 0028's `beforeLoad` redirects to `/login` → the cookie then persists in the PWA's **own** jar across launches. **Document the one-time iOS re-login as expected; no architecture change.** (Do **not** adopt the `crossorigin='use-credentials'` manifest + temp-token `start_url` workaround for v1 — revisit only if a measurable share of iOS users churn at that step.) iOS storage eviction is LRU-under-pressure + a cap after a period of inactivity (treat the cache as ephemeral — shell-only precache + best-effort `navigator.storage.persist()`; cannot be fully prevented on iOS).

**iOS / EU DMA:** iOS 17.4+ in the EU can open Home-Screen sites as plain **Safari tabs** (no standalone, no push) → the app must work in a plain tab and **never gate any core capability on standalone mode or push.** iOS web push is standalone-only/unreliable → treat push as an **optional enhancement only** for v1.

### Pins (verified live npm 2026-05-31, `wf_734a602e-3d6` Verdict 2; corrections folded in)

| Package | Pin | Note |
|---|---|---|
| `vite-plugin-pwa` | `1.3.0` | `peerDep` vite includes `^8.0.0` (matches ADR 0035 `vite@8.0.14`). |
| `workbox-{build,window,precaching,routing,strategies,core}` | `7.4.1` | Bundled/peered by `vite-plugin-pwa@1.3.0`. |
| `@base-ui/react` | `1.5.0` | `Drawer` is the one primitive for off-canvas nav + mobile right rail + bottom sheets (full pin in ADR 0037). |
| `playwright` | `1.60.x` | **CORRECTED** (latest 1.60.0; not the "1.59 line"). Device registry + `context.setOffline` + `emulateMedia` unaffected. |
| `vitest` | `4.x` (latest `4.1.7`) | **CORRECTED** (not literally "4.0"). Browser Mode stable; provider `@vitest/browser-playwright`. |
| `@axe-core/playwright` | current | WCAG 2.1 AA incl. 2.5.8 target-size (ADR 0033). |
| `y-indexeddb` | `9.0.12` | **NOT adopted** (see offline stance). |

**Playwright test gaps** (both issues CORRECTED to *closed, P3-collecting-feedback*; behaviours still real): cannot emulate installed-PWA / `display-mode: standalone` (#26853) — mock `matchMedia` via `addInitScript`; `context.setOffline` does **not** reliably fail SW-served requests (#2311) — assert cached/served **UI state**, not network failure. Layer a real-device cloud for iOS-Safari keyboard/IME paths emulation can't reproduce.

## Consequences

- An **installable, mobile-usable PWA with no change to the auth architecture**; the SW caching boundary is auditable and SSOT-derived from ADR 0035's reserved prefixes.
- **"Offline = read-only" is the honest v1 promise.** Offline-write is explicitly deferred behind a hard invariant boundary — not silently half-built where it would look like it works while breaking invariants 3 and 5.
- **Mobile editor keyboard + safe-area are owned app code** — a clean boundary precisely because we own the editor (ADR 0038).
- **The SW is outside the OTel span context (ADR 0019)** → log SW update/activation events to the **app**, not via the SW.

## Revisit triggers

- **Offline-write gets scheduled** → it unlocks only with the Phase-4 dispatcher-mediated WS write path + re-authz-and-audit-on-sync; design per-intent replay and re-evaluate `y-indexeddb` vs the Storage Buckets API vs a thin owned provider **explicitly**, never silently.
- A **measurable share of iOS users churn at the one-time re-login** → reconsider the temp-token `start_url` workaround.
- **Vite/Rolldown breaks `vite-plugin-pwa`** manifest/precache → pin + cooldown response (ADR 0035).
- **iOS lifts standalone-partition isolation or the web-push restriction** → revisit the install / push posture.

## Amendments

- **2026-06-12 — §1 implementation landed** (apps/app `src/sw.ts` + `vite-plugin-pwa@1.3.0`; proven by `packages/e2e/test/pwa.spec.ts` against the trunk-served production build). Empirical refinements to the letter of §1, none to its substance:
  - **Denylist boundary regex is `^<prefix>(?:[/?]|$)`** — workbox's `NavigationRoute` tests each RegExp against the concatenated `pathname + search`, so the boundary after the prefix must also accept `?` (the prefix root with a query), not just `/` and end-of-string. Derived in `src/lib/sw-denylist.ts` from the ADR 0035 §2 SSOT; the unit test pins the matching semantics.
  - **The Rolldown smoke is green**: under Vite 8 (Rolldown), manifest injection + precache hashing emit the expected shell precache (index.html + every hashed js/css + the three runtime-loaded latin `@fontsource` subsets + icons; the other unicode-range font subsets stay network-loaded by glob choice, not accident). The e2e spec asserts the precache contents, so a future bundler regression fails the lane, not production.
  - **`virtual:pwa-register/react` is a verified no-op in dev** (read from the shipped `client/dev/react.js`: state stays false, no registration attempt) — the dev loop and the dev-origin e2e specs run SW-less with `devOptions` unset; only the production build registers. The PWA e2e project therefore runs on the TRUNK origin with the built SPA statically attached (`EDITORZERO_SPA_DIST`), which doubles as continuous proof of the ADR 0027/0035 attach path.
  - **`registerType: 'prompt'` flow as decided**: `injectRegister: false`, the single registration site is `components/pwa-prompt.tsx` (`useRegisterSW`), SKIP_WAITING only from the update toast's Reload. SW lifecycle is surfaced as UI state, not console/OTel (ADR 0019 stance). `navigator.storage.persist()` requested best-effort post-registration. Both install paths shipped (`beforeinstallprompt` capture verified firing on Chromium against the built app; iOS one-time Share hint gated on the `lib/pwa.ts` policy, dismissal persisted under `ez-pwa-ios-hint-dismissed`).

## Cross-references

- **Layers on** ADR 0027 (same-origin trunk), ADR 0028 (`beforeLoad → /login`), ADR 0030 (Lax cookie — holds inside the installed app), ADR 0035 (SPA scaffold; reserved-prefix SSOT; supply-chain posture extends to PWA pins).
- **Pairs with** ADR 0037 (Base UI `Drawer`; the Floating-UI keyboard/safe-area gap is hand-owned) and ADR 0038 (owned editor — mobile keyboard ownership). **Honours** ADR 0019 (SW outside OTel), ADR 0033 (a11y / 2.5.8), and invariants 3 + 5.
- **Research:** `wf_734a602e-3d6` Verdict 2 (PWA/mobile/offline, live npm + spec/GitHub verification 2026-05-31) + the PWA-layer, offline-stance, and responsive/touch synthesis memos.
