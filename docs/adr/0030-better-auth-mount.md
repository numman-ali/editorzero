# ADR 0030 — Better Auth mounted in-trunk, same-origin, zero framework adapter

**Status:** Accepted (2026-05-30)
**Date:** 2026-05-29
**Deciders:** @numman (determination delegated to Claude Opus 4.8; review `wf_b3e0aac1-bff`)

## Context

Nomi's framing: *"Hono with Better Auth mounted, with a Next.js adapter at the mount — the API should ideally ONLY have the mount if Next.js is chosen."* ADR 0027 rejected Next.js, which **removes the conditional entirely**: there is no framework above the trunk, so there is no framework adapter to write. What remains is to fix where Better Auth lives and how its session reaches both the JSON-RPC surface and the collab WebSocket.

The original Next framing carried two now-moot hazards (project gotchas): `getServerSession` cannot be called inside a `"use cache"` scope, and `cookies()`/`headers()` cannot run inside `"use cache"`. With Next gone, both vanish.

## Decision

**Better Auth mounts directly on the Hono trunk** (its handler mounted at `/auth/*`), constructed once in the composition root (`getApiApp()`, ADR 0027/0029). No `@hono/*` framework adapter, no Next handler shim — the trunk *is* the server, so Better Auth's own request handler is the mount.

- **Same-origin → `SameSite=Lax`, no CORS.** The SPA, the JSON-RPC surface, and `/auth/*` are all on one origin (ADR 0027), so session cookies are first-party `Lax` cookies. No `SameSite=None`, no CSRF-token dance imported by a cross-origin split, no `trustedOrigins` allowlist beyond the canonical origin. This is the concrete same-origin dividend ADR 0027's topology buys.
- **One auth instance, shared with the dispatcher and the WS.** The Better Auth instance built in the composition root is the same one the capability dispatcher consults to resolve the principal (humans *and* agents — agents are first-class principals, ADR 0016) and the same one Hocuspocus's `onAuthenticate` calls to validate the session cookie on the collab WebSocket upgrade (ADR 0027). The session is resolved **once, in the trunk** — surfaces never re-implement permission/identity logic (invariant 5).
- **Published reader path needs no auth.** Custom domains (ADR 0011, via Caddy) serve the public static reader HTML, which carries no session — so multi-domain cookie scoping is a non-issue; auth cookies stay bound to the canonical app origin.

## Consequences

- **The "adapter at the mount" line item disappears, not simplifies.** The deliverable is "construct Better Auth in the composition root and mount its handler" — there is no adapter package, no conditional-on-framework branch. Nomi's "only the mount if Next" intent is satisfied by there being *only the mount*.
- **Cookie security posture is the simplest correct one.** `Lax` + first-party + `HttpOnly` + `Secure` (behind Caddy TLS). No exception surface to audit.
- **WS auth is real, not assumed.** ADR 0027's prerequisite smoke must exercise `onAuthenticate` resolving an actual Better Auth session cookie on the upgrade — an unauthenticated or wrong-workspace upgrade must be rejected before "embedded Hocuspocus on one port" is asserted as built. This is the security-sensitive edge of the co-hosting story.
- **Agent principals authenticate differently from humans.** Agents use token/key credentials (ADR 0016), not the browser cookie flow; the dispatcher's principal resolution already unifies both. This ADR doesn't change agent auth — it ensures the *human* browser path is same-origin-simple and that both feed one resolver.

## Revisit triggers

- **The frontend must split to a different origin** (CDN-hosted SPA, separate auth domain): the `Lax`/no-CORS dividend is lost — re-introduce `trustedOrigins`, `SameSite=None`, and CSRF handling. This is downstream of ADR 0027's single-box revisit trigger.
- **A second auth method with a different cookie/redirect model** (SSO/OIDC, SAML) lands: re-confirm the same-origin assumptions and the WS `onAuthenticate` path hold for the new flow.

## Cross-references

- **Depends on** ADR 0027 (same-origin topology; the composition root + WS `onAuthenticate`), ADR 0011 (Caddy/custom domains — public, auth-free).
- **Feeds** the dispatcher's principal resolution (invariant 5, ADR 0016 agent principals) and ADR 0028's `beforeLoad` session guard.
- **Retires** the Next-only `getServerSession`-in-`"use cache"` and `cookies()`-in-`"use cache"` gotchas.
