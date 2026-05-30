# ADR 0029 — API package shape: registry-generated per-route Hono factories under one tuple literal

**Status:** Accepted (2026-05-30; refines ADR 0021)
**Date:** 2026-05-29
**Deciders:** @numman (determination delegated to Claude Opus 4.8; review `wf_b3e0aac1-bff`)

## Context

Nomi's framing for the trunk: *"the API itself should be a package composed of Hono factory functions per single route, like capabilities are."* ADR 0021 already established folder-per-route and the load-bearing composition primitive — `openapiRoutes([...] as const)` — where the **tuple literal is what `hc<AppType>` infers from**. The 2026-04-19 amendment to 0021 documented the landmine concretely: `app.route(prefix, subApp)` sub-app composition **breaks the `AppType` tuple-merge**, so the per-route handlers cannot be composed as mounted sub-apps. The open delta this ADR closes: make routes genuinely per-route *factories* (each route a self-contained unit with its own middleware, like a capability is a self-contained unit) **without** regressing typed RPC, and without hand-maintaining the parity between the registry and the route list.

## Options considered

- **Hand-authored per-route files, hand-assembled into the tuple** (status quo extended) — REJECTED as the SSOT story: the registry already enumerates every capability/surface cell; re-typing each into a route file and into the tuple is duplicated truth that drifts (the mirror failures already caught on `doc.update`/`workspace.update`/audit routes are this class of bug).
- **Runtime composition** — build the route array with `.map`/`.reduce` over the registry at startup — REJECTED: a mapped array is not a tuple literal; `hc<AppType>` inference collapses to a union/`never`. The amendment to 0021 is explicit that the literal is load-bearing.
- **Registry-generated route factories, committed to disk, spread into one literal** — CHOSEN.

## Decision

**A codegen step derives one Hono factory file per route from the capability registry, commits it to disk, and emits the single `openapiRoutes([...] as const)` tuple literal that lists them.** The generator is part of the same SSOT pipeline that already produces OpenAPI / MCP / the contract matrix (AGENTS.md: "capability registry → OpenAPI / MCP / contract matrix").

- **Per-route factory.** Each generated file exports a factory that builds one route — its method/path, its zod parse boundary (mirroring the capability schema's refines — the mirror rule, restated at this boundary), its per-route middleware chain, and its handler delegating into the capability dispatcher. "Factory per single route, like capabilities are" is satisfied literally: one file, one route, self-contained.
- **The tuple stays a literal.** Codegen emits `openapiRoutes([routeA, routeB, ...] as const)` as source text — a literal in the committed file, never a runtime `.map`. `hc<AppType>` infers from it exactly as ADR 0021 requires. The "never runtime-compose" constraint is now mechanically guaranteed because nothing hand-writes the assembly.
- **Generated, committed, gated.** The files are checked in (diffable, reviewable, greppable — agentic-engineering-at-scale wants the generated surface visible, not hidden behind a build step) and `pnpm coherence` fails if regeneration would change them, the same way the OpenAPI/contract artifacts are gated. Registry is the single source; the route files and the tuple are derived.
- **The generated route declares its typed *error* arm at the definition boundary.** `hc<AppType>` infers a route's response type from what the route definition declares — a Hono global `onError` / error middleware is **invisible** to that inference (Codex finding). So the generated factory emits each route's typed error responses (the ADR 0033 envelope) **into the route's own return union**, not around it — otherwise the typed client sees only the success arm and error handling falls back to untyped status-code reads. Generating this guarantees uniformity; hand-authoring it guarantees omissions.

### Two corrections folded in (review red-team)

- **Per-route factories do *not* remove the principal cast.** An earlier framing claimed factoring routes would eliminate the `c.get('principal')` / `c.var.principal` cast. That is false: the principal is injected by auth middleware and read through Hono's `Variables` generic regardless of whether routes are factored; factoring changes *where the file lives*, not the typing of context vars. The honest win is **isolation and uniformity** (each route's middlewares are declared in one place, generated identically), not cast elimination. Typing the principal properly is an ADR 0030 / dispatcher concern, tracked separately.
- **Confirmed adapter-mirror drift (Codex-verified).** `doc.create` does **not** mint `collection_id` (the original suspicion); the real drift is that the **route accepts any UUID** (`packages/api-server/src/routes/docs/create.ts`) while the **capability requires UUIDv7** (`packages/capabilities/src/doc/create.ts`). The dispatcher revalidates, so runtime is safe — but OpenAPI / the typed client / generated-client schemas **advertise a more permissive contract than runtime enforces**, exactly the mirror failure (AGENTS.md: "adapter schemas mirror capability schemas"). Codex found the **same pattern across several collection / doc move/update/delete routes**. This is the strongest argument *for* this ADR: hand-authored route files keep rediscovering this drift one route at a time; generating the route's parse boundary *from* the capability schema closes the whole class at the source. (The concrete routes are fixed in the implementation slice; the generator prevents recurrence.)

## Consequences

- **Registry→route parity becomes mechanical**, not vigilance. The drift class that produced the `doc.update`/`workspace.update`/audit mirror bugs is closed at the source for generated routes: the boundary schema is emitted *from* the capability schema.
- **The generator is new infrastructure to own** (and to test): a generation bug now mints a wrong contract across every route at once. It needs its own unit/golden tests, and the coherence gate is the backstop. This is the standard SSOT-codegen trade — concentrated, testable risk over diffuse hand-maintenance.
- **The composition root is the home for this.** The generated tuple is assembled in `getApiApp()` (the composition root ADR 0027 names as the first deliverable) alongside the ADR 0030 auth instance and the dispatcher wiring. Per-route middleware that needs shared singletons (rate-limit store, auth) receives them there.
- **Manual escape hatch stays available.** A genuinely bespoke route (an odd non-capability endpoint) can still be hand-authored and added to the literal; the generator covers the capability surface, which is the part that must not drift.

## Revisit triggers

- **A route needs per-instance composition the generator can't express** (dynamic middleware by tenant/plan): add a declarative hook to the generator input rather than dropping back to hand-assembly that breaks the literal.
- **`as const` tuple inference hits a size ceiling** as the route count grows (TS instantiation depth): partition into per-domain tuples + per-domain `AppType`, exposed as per-domain clients (coordinate with ADR 0028).

## Cross-references

- **Refines** ADR 0021 (folder-per-route, `openapiRoutes([...] as const)`, the tuple-literal landmine).
- **Feeds** ADR 0028 (the `AppType` the client infers), ADR 0033 (the error envelope these handlers return).
- **Composition root shared with** ADR 0027 (`getApiApp()` / `serve()` entrypoint) and ADR 0030 (auth instance).
