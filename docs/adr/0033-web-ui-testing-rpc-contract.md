# ADR 0033 — Web UI testing strategy and the typed RPC error contract

**Status:** Accepted (2026-05-30)
**Date:** 2026-05-29
**Deciders:** @numman (determination delegated to Claude Opus 4.8; review `wf_b3e0aac1-bff`)

## Context

Nomi's framing asked for *"best test practices + Hono RPC usage"* as a first-class part of the Web UI decision, not an afterthought. Two things need fixing before the SPA exists: the **error half** of the typed RPC contract (the happy path is typed by `hc<AppType>`; errors are not, by default), and a **test posture for a client-only ProseMirror editor**, which `happy-dom`/`jsdom` cannot fully exercise (the project gotcha: the headless mutation smoke ran under `happy-dom` and is explicitly "good enough for the smoke, not blessed for production adapters").

## Decision

### 1. Typed RPC error contract — `ApplyGlobalResponse`
The dispatcher already returns structured errors; the Web UI must consume them as a **typed envelope**, not by reading status codes ad hoc. We adopt a single global response shape applied across every generated route (ADR 0029) — an `ApplyGlobalResponse`-style discriminated union: success carries the typed payload, failure carries a typed error code + machine-readable detail (the same taxonomy the CLI/MCP surface). The `api-client` (ADR 0028) **unwraps this envelope in exactly one place** — call sites get a typed result, never a raw `Response`. The envelope's error arm mirrors the dispatcher's error taxonomy (the mirror rule applied to the *error* contract), so a 409-conflict or permission-denied is the same typed shape on API, CLI, MCP, and UI.

**The error arm must live at the route definition boundary, not in a global handler (Codex finding).** `hc<AppType>` infers each route's response type from what the route *declares*; a Hono global `onError` or error middleware is invisible to that inference, so an error shape emitted only globally would be **untyped** at the client. The ADR 0029 generator therefore emits each route's typed error responses **into the route's own return union** — the envelope is part of `AppType`, not bolted on around it.

**Concrete gap this contract closes (Codex-found bug):** `doc.create` currently has **no slug-uniqueness pre-check** despite a DB unique index on doc slug (`packages/db/src/drivers/sqlite-ddl.ts`), so it can leak a raw DB unique-violation instead of the typed 409 its sibling handlers return. Making "what errors can this route return" a *declared, tested* part of the contract forces the fix: a route that can hit a unique index must declare and return the typed 409. Fixed in the implementation slice; enforced thereafter by the generated error arm + the parity tests below.

### 2. Editor tests run in a real browser
ProseMirror/Yjs editor behavior (selection, the `editor.mount` dispatch path, collaborative cursors, track-changes decorations from ADR 0032) is tested in a **real browser context** — Vitest **browser mode** (Playwright provider) for component/integration-level editor tests, and Playwright e2e for full flows. `happy-dom`/`jsdom` stay for pure-logic and non-editor component tests where they're faster, but the editor's production behavior is **never** asserted solely under a DOM shim. This closes the gotcha: the production editor adapter's DOM substrate is a real browser, decided here rather than deferred.

### 3. Contract-matrix parity fails the build on an unbound `ui` cell
`packages/contract-tests` extends the existing capability-matrix parity (invariant 4) to the **`ui` surface**: every type-compatible capability must have a Web UI binding, and an **unchecked type-compatible `ui` cell fails the build** (ADR 0009/0015). This is what mechanically forces "every capability exists on every type-compatible surface" to include the Web UI — including the ADR 0032 version/track-changes capabilities.

### 4. Standard lanes and accessibility
- **Fast lane (pre-commit):** unit + non-editor component tests (`happy-dom`), typed-client type-level smoke (a compile assertion that `client.<route>` infers the expected input/output and the error envelope — the cheap guard against the `hc<AppType>` inference regression ADR 0027/0028 flag).
- **Slow lane (pre-push):** Vitest browser-mode editor tests, Playwright e2e, **`@axe-core/playwright` WCAG 2.1 AA** (the existing accessibility floor), contract-matrix parity.
- **Coverage floor unchanged:** 95 line / 90 branch / 95 function / 95 statement (`vitest.shared.ts`) applies to Web UI packages like every other.

### 5. Hono RPC test posture
Route/handler tests run the typed client against `app.request` via `createServerClient` (ADR 0021's in-process builder) — no network, full type inference, the "minimal-app test posture" ADR 0021 already established. HTTP-path tests (`createHttpClient`) cover the same routes over a real `serve()` instance in the integration lane, including the ADR 0027 co-hosting smoke.

## Consequences

- **Errors stop being stringly-typed at the UI.** A permission-denied or conflict renders from a typed code, identical across surfaces; the SPA can't drift from the CLI's error handling because both consume one envelope.
- **The editor is tested where it actually runs.** Browser-mode tests cost more wall-clock (real browser boot) and land in the slow lane; the fast lane stays fast on logic. The track-changes decorations (ADR 0032) have a real home to be asserted in.
- **The `ui` parity cell is now load-bearing.** Adding a capability without a UI binding fails the build — the same forcing function that keeps API/CLI/MCP honest now covers the Web UI, so the parity invariant can't quietly regress as the SPA grows.
- **A type-level RPC smoke is new test infrastructure.** Asserting *types* (not just runtime) needs `expectTypeOf`/`tsd`-style checks in the suite; cheap, and the early-warning for `AppType` inference blowups that have no RSC fallback (ADR 0027).
- **Vitest browser mode + Playwright are new dev-dependencies and CI surface** (browser binaries in the pre-push/integration environment). Accepted: the editor's correctness is the product, and it cannot be certified under a DOM shim.

## Revisit triggers

- **Browser-mode editor tests dominate pre-push wall-clock**: shard them or move the heaviest to a nightly/integration-only lane, keeping a representative subset at pre-push.
- **The error taxonomy grows surface-specific arms** (a UI-only error the CLI can't produce): re-confirm the single-envelope assumption still holds, or formalize per-surface extensions of the shared base.
- **`hc<AppType>` type-level smoke gets slow or flaky** as routes multiply: gate it per-domain alongside the ADR 0029 per-domain `AppType` split.

## Cross-references

- **Implements the test/observability obligations of** AGENTS.md (fast/slow lanes, coverage floor, WCAG) for the Web UI surface.
- **Tests the contract of** ADR 0028 (typed client + cache keys), ADR 0029 (generated routes + error envelope), ADR 0032 (track-changes capabilities).
- **Extends** the capability-matrix parity (invariant 4, ADR 0009/0015) to the `ui` surface; uses ADR 0021's `createServerClient`/`createHttpClient` test posture and ADR 0027's co-hosting smoke.
