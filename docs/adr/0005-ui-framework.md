# ADR 0005 — UI framework: Next.js 15 App Router

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Four UI hot paths: the block editor, the document tree / navigation, real-time collab overlays, and the public published-docs render. The first three are interactive and JS-heavy; the last is SEO-sensitive. Editor ecosystem support (Milkdown, cmdk, Radix, dnd-kit) is deepest in React; Svelte/Solid/Qwik are thinner by material margins in April 2026.

## Options considered
- **Next.js 15 App Router** — stable, mature App Router (post-v13 shake-out), RSC + Server Actions, static export and ISR for public pages, first-class React 19 support. One build graph, one routing model.
- **React 19 + Vite + TanStack Start** — attractive but pre-1.0 as of April 2026; breaking changes between minors; thinner SSR streaming story. The red-team flagged "pick one; don't list a fallback." Accepted.
- **React 19 + Vite + TanStack Start + Astro** (original plan) — three frontend frameworks = two hydration models, two router philosophies, two CSS-ordering bug classes, a shared-component-package `"use client"`-vs-islands seam. Complexity without requirement-level justification.
- **SvelteKit 2 + Melt UI + svelte-tiptap** — viable but thinner editor bindings; no Milkdown Svelte binding.
- **SolidStart / Qwik City** — aspirational for this workload in 2026.

## Decision
**Next.js 15 App Router. One framework, one build graph.**

Route groups split the surfaces:
- **`(app)/`** — authenticated editor, tree, workspace UI, collab overlays. Client-side React components using Milkdown + `y-prosemirror` against Hocuspocus (ADR 0006). RSC for initial data loads; Server Actions for mutations are routed through the capability layer (ADR 0015).
- **`(public)/[domain]/[slug]`** — published-docs render. Static export or ISR per published doc; zero or near-zero client JS for read-only pages. Custom domains resolved via Caddy → backend `ask` endpoint → `(public)` route (ADR 0011).
- **`(api)/api/`** — HTTP API handlers; route handlers call into the capability layer.

Shared UI lives in a workspace package (`@editorzero/ui`) consumed by both route groups. No cross-framework island seam; everything is React.

## Consequences
- First-class support for Milkdown, Radix, cmdk, dnd-kit, TanStack Table — no porting, no islands gymnastics.
- Public render uses Next's static export / ISR; zero-JS-by-default is achievable with `"use server"` components and selective `"use client"` hydration.
- Single build pipeline; single routing mental model; single deployment artifact.
- Bundle size for the editor route is dominated by ProseMirror + Yjs + Milkdown extensions, not the framework.
- Accept Next.js's opinions (App Router conventions, React 19 alignment); the ecosystem moves with them.

## Revisit triggers
- A Solid/Qwik-native editor stack reaches parity with React and delivers a perf delta visible on our target hardware.
- Next.js 15 introduces a paradigm shift we cannot absorb.
- Published-docs pages prove too JS-heavy despite Next's static export — at that point, reintroduce Astro for the public surface with a clearly-drawn boundary.
