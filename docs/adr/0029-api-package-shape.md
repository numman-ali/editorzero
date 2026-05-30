# ADR 0029 — API package shape: registry-generated code-first routes (`hono-openapi` + `hono/factory`)

**Status:** Accepted (2026-05-30; revised same day — substrate reversed from `@hono/zod-openapi` to `hono-openapi` + `hono/factory`; retires ADR 0021's 2026-04-19 `openapiRoutes` tuple amendment)
**Date:** 2026-05-29 (substrate revised 2026-05-30)
**Deciders:** @numman (substrate reversal raised by @numman; determination by Claude Opus 4.8, validated by empirical `tsc` spikes + Codex peer red-team)

## Context

Nomi's framing for the trunk: *"the API itself should be a package composed of Hono factory functions per single route, like capabilities are."*

The **prior revision of this ADR** (and ADR 0021's 2026-04-19 amendment) committed to **`@hono/zod-openapi`** with `openapiRoutes([...] as const)` as the composition primitive, resting on two beliefs: (i) the **tuple literal is what `hc<AppType>` infers from**, so a missing `as const` silently degrades the typed client to `unknown`; and (ii) `app.route(prefix, subApp)` sub-app composition **breaks the `AppType` merge**. Together those made a code-*generated* literal tuple load-bearing — the architecture existed largely to keep that tuple honest.

Nomi reopened the substrate choice: *schema-first `@hono/zod-openapi` vs code-first `hono-openapi` + `hono/factory`* was never actually locked down, and he was leaning code-first ("cleaner; composes with `createFactory`; validators are built in and enforce coercions; the returns are picked up by the `hc` RPC types automatically" — and he'd shipped it before). Re-evaluated unbiased and validated empirically rather than by assertion.

**Three `tsc` spikes (hono 4.12.14 / hono-openapi 1.3.0 / zod v4) overturned the premise:**

1. `factory.createHandlers(describeRoute(…), validator("json", schema), handler)` preserves `hc<AppType>` **input *and* output** inference.
2. **`.route()` cross-domain composition preserves `hc` inference** — the `AppType` merge survives ordinary sub-app chaining. The tuple-merge landmine was an artifact of the `openapiRoutes` primitive, **not** a law of Hono RPC. Belief (ii) is false.
3. A branded `.transform()` capability schema fed **directly** to `validator("json", …)` types the handler's `c.req.valid("json")` as the branded `Out`, while the typed client accepts the wire `In` — **true SSOT with no restated route schema.**

A Codex peer red-team confirmed the reversal and sharpened it (refinements folded into the Decision below; Codex independently stress-tested route count to the TS depth ceiling).

So the open delta this ADR closes is **reframed**: pick the substrate that makes "factory per single route, composes like capabilities" native, and justify code generation by **registry parity + SSOT (invariant 4 / the mirror rule)** — *not* by a typing constraint that no longer exists. The tuple-factory architecture must not survive as a ghost.

## Options considered

### A. `@hono/zod-openapi` — schema-first; `createRoute` + `app.openapi`; `openapiRoutes([...] as const)` — the prior choice, REVERSED

Schema-first splits the route *declaration* from the handler and, in the 1.3.0 modular pattern, leans on the `as const` tuple primitive. Two problems, one fatal:

- **The tuple is fragile and its justification is empirically false.** A dropped `as const` silently degrades `hc` to `unknown` (a footgun the prior amendment documented at length). The reason given for tolerating that footgun — "the literal tuple is the *only* composition that preserves the `AppType` merge; `.route()` breaks it" — **does not hold** (spike 2). The whole tuple apparatus was load-bearing for a constraint that isn't real.
- **It subclasses `OpenAPIHono`**, diverging from the plain-`Hono` + `hono/factory` idiom the rest of the stack (and `hc`) is built around, and from Nomi's "compose like capabilities" intent.

The 2026-04-19 rejection of `hono-openapi` (bus-factor-1; issue #216 "blocks `.route()` composition + spec generation"; "response types not coupled to `hc` by default") is **superseded**: v1.3.0 + the factory shape demonstrably couples returns to `hc` (spike 1) and composes via `.route()` (spike 2). The maturity concern is real and survives — handled by the adapter fence below, not by avoiding the library.

### B. `hono-openapi@1.3.0` + `hono/factory` — code-first — CHOSEN

Ordinary Hono on a plain `Hono` instance:

```ts
const factory = createFactory<ApiEnv>();
const docsRoutes = new Hono<ApiEnv>()
  .post(
    "/create",
    ...factory.createHandlers(
      describeRoute({ description: "Create a doc", responses: { 201: …, 409: …, 403: … } }),
      validator("json", InputSchema),               // In = wire shape; Out = branded (SSOT, §3 below)
      async (c) => {
        const input = c.req.valid("json");           // typed as the capability's branded Out
        const result = await dispatch(c, "doc.create", input);
        if (!result.ok) return c.json(result.error, result.status); // explicit typed error arm (§4)
        return c.json(result.value, 201);                            // explicit typed success arm
      },
    ),
  );
```

Standard-Schema-native (single root export in v1 — no `/zod` subpath); the `validator` infers In/Out from the schema and coerces; `describeRoute` (+ `resolver`) attaches the OpenAPI metadata; composition is plain `.route()` chaining that preserves `hc`. This is the "factory per single route, like capabilities" shape Nomi asked for, and the one he's shipped before.

### Generation sub-question — generated vs hand-authored

Resolved below independently of the substrate: generation is justified by **parity + SSOT**, no longer by any typing constraint.

## Decision

**Adopt `hono-openapi@1.3.0` + `hono/factory` as the route substrate; generate the route files + composition from the capability registry for parity/SSOT; wall the dependency behind an `api-openapi` adapter package.**

### Load-bearing commitments

1. **Substrate = code-first `hono-openapi` + `hono/factory`.** Each route is a `factory.createHandlers(describeRoute(…), validator(…), handler)` spread onto a plain `Hono` method call — one file, one route, self-contained, exactly "like a capability." No `OpenAPIHono` subclass, no `createRoute`/`app.openapi` split, no `openapiRoutes` tuple.

2. **Routes are *chained, captured* values; composition is `.route()` chaining** (Codex). `hc<AppType>` accumulates types only across a fluent chain on a captured instance — `new Hono().post(…).get(…)`, then `trunk.route("/docs", docsRoutes).route("/collections", collectionsRoutes)…`, with the final value captured. **Statement form is forbidden**: `const app = new Hono(); app.post(…)` discards the per-call type accumulation → `hc` collapses to `unknown`. The generator emits the chained form; the composition root chains the captured domain apps; `AppType = typeof <the chained capability-route app>`.

3. **SSOT by direct schema reuse — the request-drift class is closed at the substrate.** `validator("json" | "query" | "param", <capabilitySchema>)` is fed the capability's **own** zod schema. The handler's `c.req.valid(...)` is the branded `Out`; the typed client accepts the wire `In`. **There is no restated route schema to drift from the capability** — so the mirror failure that motivated the prior ADR (the `doc.create` route advertising "any UUID" while the capability requires UUIDv7; the same pattern across several `collection`/`doc` move/update/delete routes) **cannot recur by construction**, independent of whether the file was generated. This retires the prior ADR's strongest stated argument for generation by *solving the problem a different way*.

4. **Typed error arm = explicit per-route `c.json(envelope, status)` returns** (Codex). `hc` infers a route's response type **only from explicit `c.json(body, status)` returns in the handler**. A `describeRoute({ responses })` declaration documents OpenAPI but **does not feed `hc` types**; a global `onError` (today at `packages/api-server/src/app.ts`) and middleware-level 401s are **`hc`-invisible**. So every route returns its typed error envelope (the ADR 0033 shape) explicitly, for every arm it can produce. The generator emits these from the **error-arm map** (the route-contract audit output). This very likely implies the **dispatcher returns a discriminated `ok | error` result** the route maps to `c.json` (rather than throwing into the global mapper) — a dispatcher-contract sub-decision flagged here and settled in the dispatcher/composition-root slice.

5. **Generation is justified by registry parity + SSOT, *not* Hono typing** (Codex). The tuple-factory rationale ("must generate so the literal stays honest") is **retired**. The generator exists for the same reason the OpenAPI / MCP / contract-matrix generators do — invariant 4 (parity) and the mirror rule. What it actually buys: every type-compatible capability cell **has** a route (parity, enforced by the contract matrix); **uniform** error-arm declaration (no omissions — commitment 4); uniform OpenAPI metadata. Generated files are committed (diffable, greppable, reviewable) and `pnpm coherence` fails if regeneration would change them. A genuinely bespoke non-capability route may be hand-authored and `.route()`-chained in; because request schemas are reused directly (commitment 3), even a hand-authored route can't drift its parse boundary.

6. **OpenAPI fidelity rules** (Codex). zod v4 `.meta({ $id })` — **`$id`, not `id`** — on a shared request/response **body** schema emits a reusable `#/components/schemas/...` `$ref`; reuse bodies that way. **Query and param schemas stay inline** (no `$id` — it breaks the generated parameter component). **OpenAPI snapshot tests gate fidelity**, catching generator regressions before they ship a contract that diverges from runtime.

7. **An `api-openapi` adapter package walls the dependency** (Codex). `hono-openapi` is community-maintained (rhinobase), effectively single-maintainer, and self-describes as "in development." Mitigations, not avoidance: **pin exact versions** (no `^`) for `hono-openapi` + `@hono/standard-validator` + the `@standard-community/*` peers; route **all** of their imports through one thin `packages/api-openapi` (so a future swap is a one-package change, not a tree-wide edit); and gate on an **OpenAPI snapshot** + a **type-level RPC smoke** (`client.<route>` infers the expected In/Out *and* the error envelope — the cheap early-warning for an inference regression).

8. **Composition root** (`getApiApp()`, ADR 0027/0030). It chains the generated domain apps via `.route()`, capturing the value `AppType` derives from. **Better Auth (`/auth/*`) and MCP (`/mcp`, `@hono/mcp` `app.all`) are mounted as side-effects kept *out* of the typed value** — they are not `hc` capability routes and must not pollute `AppType`. Per-route middleware needing shared singletons (rate-limit store, auth instance, dispatcher) receives them here.

### Corrections retained from the prior revision

- **Per-route factories do *not* remove the principal cast.** The principal is injected by auth middleware and read through Hono's `Variables` generic regardless of how routes are organized; factoring changes *where the file lives*, not the typing of context vars. The honest win is **isolation + uniformity**, not cast elimination. Typing the principal properly is an ADR 0030 / dispatcher concern, tracked separately.
- The **UUIDv7 mirror-drift** example is now **prevented by construction** (commitment 3). The remaining `doc.create` gap — **no slug-uniqueness pre-check**, so it can leak a raw DB unique-violation instead of the typed 409 its siblings return — is an **error-arm** gap, closed by commitment 4 + ADR 0033 (the route must declare and return the typed 409), not a request-schema drift.

## Consequences

- **Registry→route parity stays mechanical, and the request-drift class is closed *twice*** — once by parity generation, once (independently) by direct schema reuse, so even the manual escape hatch is safe.
- **The footgun is gone.** No `as const` tuple whose silent widening degrades `hc` to `unknown`; no "never runtime `.map`" rule to police. Composition is the plain `.route()` chaining the rest of Hono uses — a simpler mental model for every agent authoring routes.
- **The generator is concentrated, testable risk** (a generation bug mints a wrong contract across every route at once) — owned by golden/unit tests + the coherence gate + the OpenAPI snapshot. Standard SSOT-codegen trade.
- **The substrate is a maturity bet, fenced.** `hono-openapi`'s single-maintainer / "in development" status is mitigated by exact pins, the `api-openapi` wall, the OpenAPI snapshot, and the RPC type smoke — not by avoiding it. If it's abandoned, the swap is one package.
- **Scale headroom is ample.** The code-first `.route()` chain is clean to ~288 routes; TS2589 (excessive instantiation depth) appears around ~320 (Codex-measured). We are at ~26. The escape, if approached, is the per-domain `AppType` split + per-domain precompiled clients (ADR 0028) — already the named mitigation for `hc` inference cost.
- **An existing ~26-route `@hono/zod-openapi` implementation must be migrated — this is not greenfield.** The schema-first substrate is already built across the route tree + per-route unit tests + `app.ts`/`env.ts` (≈26 capability routes as of P3.7). The reversal makes that a **migration**: each route moves from `createRoute`/`defineOpenAPIRoute`/`openapiRoutes([...] as const)` to `factory.createHandlers(describeRoute(…), validator(…), handler)` chained via `.route()`; minimal-app tests swap `OpenAPIHono`→`Hono`; `.openapi("Name")`→`.meta({ $id })`. It is the capability-sharded build slice that *follows* this ADR (one route per agent), gated by the OpenAPI snapshot + RPC type smoke. Until it lands the trunk stays on the schema-first substrate and remains releasable, so the migration can proceed route-by-route rather than as a single cutover.

  **Update — migration landed (2026-05-30).** All 26 routes + the 5 domain indexes + the `app.ts` trunk are now code-first; `@hono/zod-openapi` is dropped from `api-server`. The capability-sharded build ran as one orchestrated workflow (3 shared sub-schemas + 23 capability schema extractions + 25 route migrations, gated by typecheck + adversarial verify). Three implementation findings refine the plan above:
  - **SSOT was realised as a package, [ADR 0034](0034-schemas-ssot-package.md).** Commitment 3's "reuse the capability's own schema" became `@editorzero/schemas` — a light leaf both capabilities *and* surface routes import, so the route↔capability wire contract has exactly one definition. The kernel's `Capability.input: ZodType<unknown>` erasure (which would have collapsed `z.input` to `unknown`) is bypassed by importing the schema directly.
  - **The `api-openapi` *package* wall (commitment, §7) was right-sized to a *module* wall** — `src/lib/openapi.ts` is the sole importer of `hono-openapi`; `openApiDocument(app)` is the public seam (the CLI parity check imports it, never `hono-openapi`). Recorded as a §7 amendment in that file; promote to a package only when a second package needs the primitives.
  - **No named components — schemas inline.** `.openapi("Name")` did **not** become `.meta({ $id })`: hono-openapi 1.3.0's `resolver`/`generateSpecs` do not extract named `components.schemas` from `.meta({ id })`, so response schemas inline into each operation. The trunk test asserts the inlined 200 schema rather than a named-component `$ref`; the spec is accurate either way.

## Revisit triggers

- **`hono-openapi` is abandoned or regresses `hc`/`.route()` inference or Standard-Schema/zod-v4 interop** → swap the substrate behind the `api-openapi` wall (the OpenAPI snapshot + RPC type smoke catch the regression; the wall makes the swap local). The schema-first `@hono/zod-openapi` path remains the documented fallback.
- **Route count approaches the ~320 TS-depth ceiling** → partition into per-domain tuples/chains + per-domain `AppType`, exposed as per-domain clients (coordinate with ADR 0028).
- **A route needs per-instance composition the generator can't express** (dynamic middleware by tenant/plan) → add a declarative hook to the generator input rather than dropping to hand-assembly.
- **The dispatcher-returns-`ok|error` sub-decision (commitment 4) proves wrong at implementation** (e.g. throw-based flow reads cleaner with a typed-rethrow shim) → revisit how the typed error arm reaches the explicit `c.json` return, keeping the invariant that the arm is **declared at the route**, not globally.

## Cross-references

- **Refines** ADR 0021 (folder-per-route, path-mirrors-folder, minimal-app test posture, `api-client` builders — all survive) and **retires its 2026-04-19 amendment's** `openapiRoutes([...] as const)` composition primitive + the `@hono/zod-openapi`-over-`hono-openapi` rejection.
- **Feeds** ADR 0028 (the `AppType` the client infers from — now a `.route()`-composed code-first chain), ADR 0033 (the error envelope these handlers return — as explicit per-route `c.json` returns).
- **Composition root shared with** ADR 0027 (`getApiApp()` / `serve()` entrypoint; auth/MCP as side-effect mounts) and ADR 0030 (the Better Auth instance, mounted but kept out of `AppType`).

## Sources

- `hono-openapi` (chosen substrate): https://github.com/rhinobase/hono-openapi — Hono "OpenAPI via hono-openapi" example: https://hono.dev/examples/hono-openapi
- `hono/factory` (`createFactory` / `createHandlers`): https://hono.dev/docs/helpers/factory
- Hono RPC (`hc<AppType>`, `.route()` composition): https://hono.dev/docs/guides/rpc
- Empirical spikes (this session): `/tmp/hono-rpc-spike/{spike,spike2,spike3}.ts` — all `tsc` clean under hono 4.12.14 / hono-openapi 1.3.0 / zod v4.
- Standard Schema (the validator's contract): https://standardschema.dev/
