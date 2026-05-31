# ADR 0030 — Better Auth mounted in-trunk, same-origin, zero framework adapter

**Status:** Accepted (2026-05-30)
**Date:** 2026-05-29
**Deciders:** @numman (determination delegated to Claude Opus 4.8; review `wf_b3e0aac1-bff`)

## Context

Nomi's framing: *"Hono with Better Auth mounted, with a Next.js adapter at the mount — the API should ideally ONLY have the mount if Next.js is chosen."* ADR 0027 rejected Next.js, which **removes the conditional entirely**: there is no framework above the trunk, so there is no framework adapter to write. What remains is to fix where Better Auth lives and how its session reaches both the JSON-RPC surface and the collab WebSocket.

The original Next framing carried two now-moot hazards (project gotchas): `getServerSession` cannot be called inside a `"use cache"` scope, and `cookies()`/`headers()` cannot run inside `"use cache"`. With Next gone, both vanish.

## Decision

**Better Auth mounts directly on the Hono trunk** (its handler mounted at `/auth/*`), constructed once in the composition root (`getApiApp()`, ADR 0027/0029). No `@hono/*` framework adapter, no Next handler shim — the trunk *is* the server, so Better Auth's own request handler is the mount. The mount is a **side-effect on the trunk, deliberately kept out of the typed `AppType`** — `/auth/*` is not an `hc` capability route, so it must not contribute to the RPC client's inferred surface (ADR 0029 §8).

- **Same-origin → `SameSite=Lax`, no CORS.** The SPA, the JSON-RPC surface, and `/auth/*` are all on one origin (ADR 0027), so session cookies are first-party `Lax` cookies. No `SameSite=None`, no CSRF-token dance imported by a cross-origin split, no `trustedOrigins` allowlist beyond the canonical origin. This is the concrete same-origin dividend ADR 0027's topology buys.
- **One auth instance, shared with the dispatcher and the WS.** The Better Auth instance built in the composition root is the same one the capability dispatcher consults to resolve the principal (humans *and* agents — agents are first-class principals, ADR 0016) and the same one that validates the collab WebSocket's session cookie — read from the **HTTP upgrade request**, not from Hocuspocus's `token` (the verified mechanism is in Consequences). The session is resolved **once, in the trunk** — surfaces never re-implement permission/identity logic (invariant 5).
- **Published reader path needs no auth.** Custom domains (ADR 0011, via Caddy) serve the public static reader HTML, which carries no session — so multi-domain cookie scoping is a non-issue; auth cookies stay bound to the canonical app origin.

## Consequences

- **The "adapter at the mount" line item disappears, not simplifies.** The deliverable is "construct Better Auth in the composition root and mount its handler" — there is no adapter package, no conditional-on-framework branch. Nomi's "only the mount if Next" intent is satisfied by there being *only the mount*.
- **Cookie security posture is the simplest correct one.** `Lax` + first-party + `HttpOnly` + `Secure` (behind Caddy TLS). No exception surface to audit.
- **WS auth is real, the mechanism is specific, and the smoke proved it** (verified against `@hocuspocus/server` 3.4.4, the pinned version; `apps/server/src/cohost.integration.test.ts`). The collab session is **not** carried by Hocuspocus's `token`: `token` is opaque client data delivered *inside* a y-protocol Auth message *after* the socket is already open, and a browser cannot copy an `HttpOnly` cookie into it. The Better Auth session cookie rides the **HTTP upgrade request** instead, resolved through the one shared Better Auth instance — `getApiApp` now exposes `resolver` for exactly this. The control **splits across two points**, and the split is forced by Hocuspocus's model, not a preference:
  - **authN at the upgrade.** `server.on("upgrade")` reads the cookie from `request.headers.cookie`, resolves the principal via the shared `resolver`, and destroys the socket when there is none — rejecting unauthenticated clients *before* any WebSocket frame. The resolved principal is injected via `handleConnection(ws, request, { principal })` (possible only because we drive `handleConnection` ourselves; the built-in `Server` passes no context arg — source-confirmed).
  - **authZ at `onAuthenticate`.** Hocuspocus **multiplexes documents over one socket** — `documentName` is per-frame, auth is evaluated per document establishment — so per-document authorization must live where the doc name is known. `onAuthenticate` reads the injected principal from `payload.context` and authorizes `documentName` against the principal's workspace (a tenant-scoped doc lookup, invariant 5); a throw becomes Hocuspocus's permission-denied. Binding the first doc at the upgrade would not remove this — a multiplexed second `documentName` would still need the per-doc check, so one-doc-per-socket is at most optional defense-in-depth, not the gate.
  - **The gate is fail-closed — but only if `onAuthenticate` is registered.** Non-Auth frames are queued and never applied; a Document is established (and the queue flushed) *only* after a successful Auth frame, and a throw establishes nothing (`ClientConnection.ts:311-319`; sole establishment site `setUpNewConnection`). **The gate keys on the Auth frame, not on hook presence:** with no `onAuthenticate`, any Auth frame (even empty) establishes full read/write. "An `onAuthenticate` hook is registered and throws on deny" is therefore a **boot invariant** with no in-package backstop — the production WS-attach pass (ADR 0027) must assert it; the smoke always sets it.
  - **Auth state is per-connection** — a reconnect is a fresh socket and re-runs both checks, so the resolver and the authZ hook must tolerate being called on every (re)connect.

  This was the security-sensitive edge of the co-hosting story; the smoke exercised authenticated-accept, no-cookie-reject (at the upgrade), and cross-workspace-deny (as Hocuspocus permission-denied), so "embedded Hocuspocus on one port" is now demonstrated end-to-end on `@hono/node-server` **v1** — no v2 bump.
- **Agent principals authenticate differently from humans.** Agents use token/key credentials (ADR 0016), not the browser cookie flow; the dispatcher's principal resolution already unifies both. This ADR doesn't change agent auth — it ensures the *human* browser path is same-origin-simple and that both feed one resolver.

## Revisit triggers

- **The frontend must split to a different origin** (CDN-hosted SPA, separate auth domain): the `Lax`/no-CORS dividend is lost — re-introduce `trustedOrigins`, `SameSite=None`, and CSRF handling. This is downstream of ADR 0027's single-box revisit trigger.
- **A second auth method with a different cookie/redirect model** (SSO/OIDC, SAML) lands: re-confirm the same-origin assumptions and the WS `onAuthenticate` path hold for the new flow.

## Cross-references

- **Depends on** ADR 0027 (same-origin topology; the composition root + WS `onAuthenticate`), ADR 0011 (Caddy/custom domains — public, auth-free).
- **Feeds** the dispatcher's principal resolution (invariant 5, ADR 0016 agent principals) and ADR 0028's `beforeLoad` session guard.
- **Retires** the Next-only `getServerSession`-in-`"use cache"` and `cookies()`-in-`"use cache"` gotchas.
