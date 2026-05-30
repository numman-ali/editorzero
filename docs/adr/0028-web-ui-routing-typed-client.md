# ADR 0028 — Web UI client routing and the single typed-client seam

**Status:** Accepted (2026-05-30)
**Date:** 2026-05-29
**Deciders:** @numman (determination delegated to Claude Opus 4.8; review `wf_b3e0aac1-bff`)

## Context

ADR 0027 makes the SPA a bare Vite + React client bundle served by the Hono trunk. That leaves two client-side decisions: how routes are declared and guarded, and how the client talks to the trunk. ADR 0021 already fixed the data seam in principle — every surface consumes the trunk via `hc<AppType>`, with two builders in `packages/api-client` (`createServerClient` in-process, `createHttpClient` over HTTP). The risk this ADR closes is **a second data idiom** sneaking in beside `hc` (framework loaders that fetch their own way), and **raw `hc<AppType>` construction** scattered across the SPA, each call site re-deciding base URL, credentials, and error handling — the exact drift the "single source of truth, derived elsewhere" rule forbids.

## Options considered

- **TanStack Start** (full framework, its own router + SSR + server functions) — REJECTED in ADR 0027: RSC layer experimental, branded IDs (`DocId`/`WorkspaceId`/`BlockId`) not serializable across the RSC boundary. We take its router, not its framework.
- **React Router v7 (framework mode)** — REJECTED: `react-router-hono-server` inverts build ownership and RR7 loaders are a second data idiom; declarative-mode RR7 is viable but weaker on type-safe params/search than TanStack Router.
- **TanStack Router (library mode) + TanStack Query** — CHOSEN.

## Decision

**TanStack Router (stable, 1.170.x) in library mode**, code-split per route, client-only (`ssr: false`) — there is no SSR framework above it (ADR 0027). Fully type-safe routes: typed params and typed search-param schemas (zod), so deep-links into a doc/workspace are typed end-to-end and validated at the boundary like every other parse seam.

**Exactly one typed-client seam.** All trunk access goes through `packages/api-client`. `createHttpClient` (an `hc<AppType>` bound to the same origin with `credentials: 'include'`) is the SPA's only client. **Constructing `hc<AppType>` anywhere outside `packages/api-client` is forbidden** — enforced by a lint/coherence rule, not convention — so base URL, credential mode, and the ADR 0033 error-envelope unwrap live in one place and the typed contract has exactly one shape per process kind.

**Route loaders are allowed, but they call the api-client — they are not a second fetch idiom.** A TanStack Router `loader` (or a TanStack Query `queryFn`) may prefetch, but its body calls `client.<route>.$get()` from `api-client`; it never constructs a client or fetches raw. **TanStack Query owns server-state caching** (dedup, background refetch, optimistic mutations); the router owns navigation and param/search typing. The collaborative editor doc body is **not** Query-cached state — it is live Yjs over the collab WS (ADR 0027); Query caches the *metadata* surfaces (doc lists, workspace/member views, version-history index from ADR 0032), not the CRDT document.

**Route-level auth guard.** A `beforeLoad` on the authenticated route subtree resolves the session via the api-client and redirects unauthenticated loads to sign-in. This is a UX gate, **not** a security boundary — every mutation and tenant-scoped read is still permission-checked at the capability dispatcher (invariant 5); the client guard only avoids rendering a shell the trunk would reject.

## Consequences

- **One mental model, one seam.** A new capability is reachable from the SPA the instant its route exists in `AppType` — `client.<route>` is inferred; no per-call wiring. Agents authoring UI code have a single import surface to learn.
- **The forbid-raw-`hc` rule needs teeth.** A coherence/lint check (deny `hc<` / `hc(` import-and-call outside `packages/api-client`) lands with this ADR; otherwise the seam erodes one convenient call site at a time.
- **TanStack Query is a new dependency with its own cache-key discipline.** Query keys must be derived from typed route inputs (not hand-built strings) to avoid stale/duplicated caches — an ADR 0033 test concern.
- **Search-param schemas are a parse boundary.** They re-state the relevant capability refines at the URL boundary (mirror rule), so a hand-edited deep link cannot smuggle an out-of-contract value into a typed call.

## Revisit triggers

- **TanStack Start's RSC layer stabilizes and branded-ID serialization is solved** (custom serializers or a primitive-ID rethink): re-evaluate SSR for the authenticated shell — though the editor route stays `ssr: false` regardless.
- **`hc<AppType>` type-instantiation cost in the editor bundle regresses** (Hono #3869/#4638): lean harder on the ADR 0028/0029 materialized precompile; if insufficient, split `AppType` per domain and expose per-domain clients from `api-client`.

## Cross-references

- **Builds on** ADR 0027 (SPA topology), ADR 0021 (two `hc` builders, `AppType`).
- **Paired with** ADR 0029 (the `AppType` the client infers from), ADR 0033 (the error envelope the client unwraps; the cache-key + browser tests).
- **Consumes** ADR 0030's session for the `beforeLoad` guard.
