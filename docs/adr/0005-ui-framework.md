# ADR 0005 — UI framework: Next.js 16 App Router

**Status:** Superseded by [ADR 0027](0027-web-ui-topology.md) (2026-05-30)
**Date:** 2026-04-17 (v2); superseded 2026-05-30
**Deciders:** @numman

> **Superseded by [ADR 0027](0027-web-ui-topology.md) (2026-05-30), with the 0028–0033 cluster.** Next.js is no longer the Web UI framework. This ADR's choice put Next on top with the Hono trunk mounted under it — directly contradicting ADR 0021 (Hono trunk as the single source every surface consumes). ADR 0027 resolves that toward 0021: the Hono trunk is the top-level server; the authenticated UI is a Vite + React SPA served as static assets, published docs are event-rendered static HTML, and Hocuspocus is embedded on the same port. Decisive facts: Next `output:export` ⊥ `output:standalone` (can't be one container *and* zero-JS) and Next can't host the collab WebSocket.

## Context
The refresh confirmed Next.js **16** is current (16.0 GA Oct 21 2025; 16.2 Mar 2026). v1 cited Next 15; update to 16 and note the breaking surface.

## Decision
**Next.js 16.2 App Router**, React 19.2, one framework, one build graph.

Route groups unchanged from v1:
- **`(app)/`** — authenticated editor, tree, collab. Client components, BlockNote editor (ADR 0004) with `y-prosemirror` against Hocuspocus (ADR 0006). RSC for initial data loads; Server Actions route through the capability registry (ADR 0015).
- **`(public)/[domain]/[slug]`** — published-docs render. `output: 'export'` static export for the true zero-JS path; `next start` on Node for ISR / custom-domain routing. Cache via **`"use cache"` + `cacheLife`**, not the old `revalidate` export.
- **`(api)/api/`** — HTTP API handlers into the capability layer.

## Breaking surface to honor (Next 15 → 16)
- **Turbopack is default** for `next dev` and `next build`. Webpack available via `--webpack`.
- **Async Request APIs mandatory:** `params`, `searchParams`, `cookies()`, `headers()`, `draftMode()` must be awaited. No sync fallback.
- **`middleware.ts` deprecated → `proxy.ts`**, which runs on **Node.js, not Edge**. Edge runtime for this layer is not configurable from `proxy`. For us this is a **strict improvement** — direct Postgres / Redis / capability calls from the proxy layer, no cold-start Edge constraint.
- **Node 20.9+ required.** We're on Node 22 LTS — fine.
- **Removed:** AMP APIs, `serverRuntimeConfig`, `publicRuntimeConfig`, `next lint`. Use Biome or ESLint directly.
- **`revalidateTag(tag, cacheLife)`** — second argument added.

## Cache Components
Caching is now explicit opt-in via `"use cache"` + `cacheLife` + `cacheTag`, gated by the `cacheComponents` flag. The experimental `ppr` and `dynamicIO` flags are gone; PPR is folded into Cache Components. **Cached functions cannot call `cookies()`/`headers()`/`searchParams`** — design cached functions to receive request context as arguments. This affects the capability registry: capability handlers that call cached reads must pass `Principal` / `TenantContext` explicitly.

## React Compiler 1.0
Stable (opt-in, Babel-backed). **Not enabled by default** for us. Evaluate after we have a stable editor route — BlockNote + Yjs + heavy client code can trip aggressive memoization assumptions. Flip on behind a flag post-Phase-3.

## React 19.2 alignment
First-class in Next 16. Ecosystem caveats:
- **Tiptap UI components** reference React 18 in some doc paths — mostly moot since we're on BlockNote.
- **BlockNote** on React 19 works; use current stable releases.
- **Better Auth** has official Next 16 integration; known issue: `getServerSession` cannot be called inside a `"use cache"` scope — read session outside cached functions.

## Self-hosted Node deploy
`next start` on Node 22 is fully supported and first-class. `output: 'standalone'` for our single-Docker-image path. Vercel did **not** push toward lock-in in 16; the **Adapter API** is public and stable, co-designed with OpenNext, Netlify, Cloudflare, AWS Amplify, Google. Net-positive for self-hosting.

## Custom server / embedding in Hono
Still supported, still discouraged. `proxy.ts` running on Node with full native APIs absorbs most reasons one would front Next with Hono. **Decision:** keep Next as the top-level server; put shared capability-registry logic behind `proxy.ts` + Server Actions + route handlers. Use Hono for the MCP server subprocess or if we split a service later.

## TanStack Start
Hit v1.0 in March 2026 but **does not support React Server Components** — disqualifying for our `(public)` zero-JS path. Keep on the radar for an internal admin dashboard if we ever split one out.

## Consequences
- First-class support for BlockNote, Radix, cmdk, dnd-kit, TanStack Table — no porting.
- `(public)` path ships near-zero JS via RSC-only pages + `"use cache"`.
- Single build pipeline; single routing mental model; single deployment artifact.
- Turbopack-default changed caching + HMR semantics; retune Docker build cache layers in Phase 3.
- Bundle size for the editor route dominated by ProseMirror + Yjs + BlockNote — framework choice doesn't move the needle.

## Revisit triggers
- Next 17 introduces a paradigm shift we cannot absorb cleanly.
- Cache Components semantics bite capability handlers in ways we cannot engineer around.
- A Solid/Qwik-native editor stack reaches parity with React for our workload.
