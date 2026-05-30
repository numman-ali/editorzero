# ADR 0034 — `@editorzero/schemas`: single-source wire+internal contracts, reused by capabilities and surfaces

**Status:** Accepted (new, 2026-05-30; refines [0029](0029-api-package-shape.md))
**Date:** 2026-05-30
**Deciders:** @numman, Claude Opus 4.8 (with Codex cross-model on the naming convention)

## Context

ADR 0029 moved the API to a code-first shape (`hono-openapi` + `hono/factory`): each route declares its OpenAPI metadata inline and validates with `validator(target, schema, hook)`. The first cut had every route **re-declare** its request/response zod schema, with a "mirror rule" justifying the duplication.

That duplication has a precise root cause, not a stylistic one. The capability kernel exposes `Capability<I, O>` with `input: ZodType<I>`. In zod v4, `ZodType<I>` is `ZodType<Output = I, Input = unknown>`, so `z.input` of a capability's `input` schema collapses to `unknown`. The heterogeneous registry/dispatcher deliberately erases further: `RegisteredCapability.input: ZodType<unknown>`. So a route that fed `capability.input` to `validator` got an `hc` client typed `unknown` on the request body — useless. Routes re-declared the wire schema to recover a usable type. The cost: the wire contract for each capability existed in **two** places (capability + route), free to drift — and drift had already been caught on `doc.update`, `workspace.update`, the audit routes, and CLI flag parsing (AGENTS.md § Adapter schemas).

@numman's mandate: *"strongly typed data from bottom to top and left and right from a single source of types, with only shapes changing where necessary. Zod types should be reusable literally everywhere."* Plus a hard no-casts rule: narrow via `parse`/type-guard, never `as`.

The decisive enabling fact (spike, 2026-05-30): a **transform-bearing** schema carries *both* shapes in one definition. `z.uuid({ version: "v7" }).transform(s => CollectionId(s))` has `z.input = string` (wire) and `z.output = CollectionId` (branded). hono-openapi generates the OpenAPI request from the **input** side (the UUIDv7 pattern survives — transforms do not go opaque), `c.req.valid()` is the branded **output**, and `OutputSchema.parse(result)` re-applies the branded narrowing on the response. One schema, fed to both `validator` and `resolver`, serves the wire client, the OpenAPI spec, and the branded in-process `hc` consumer — *the `.transform()` is the "shape changing where necessary."*

## Options considered

### Option A — new `@editorzero/schemas` package; capabilities and surfaces both import it
A light leaf package (`@editorzero/ids` + `@editorzero/scopes` + `zod` only) holding one schema module per capability plus shared field/sub-schemas. The capability imports its `*InputSchema`/`*OutputSchema` from it; the route imports the same. The kernel's `Capability<I,O>` public type is unchanged, so the schema layer lands non-breaking and independently.
- **Pros:** true single source — the route and the capability are literally the same `z` object; deleting re-declaration deletes the drift class entirely; surface-agnostic (CLI/MCP/UI can import the same schemas); subpath exports (`@editorzero/schemas/doc/create`) keep each capability independently importable.
- **Cons:** a new package; ~50 symbols to name + ~23 capabilities + 25 routes to re-point (mechanical, fan-out-able).

### Option A-lite — co-locate schemas next to capabilities, no new package
Export the schemas from `@editorzero/capabilities` directly.
- **Cons:** the route would import `@editorzero/capabilities` purely for types, pulling the dispatcher/handler graph into the API package's type surface; muddies the leaf-ness; the Web UI typed client would transitively depend on capability runtime. Rejected.

### Option B — sharpen the kernel so `Capability.input` keeps `z.input`
Re-type `Capability<I, O>` to preserve the input schema's wire type through the registry.
- **Cons:** the registry/dispatcher are deliberately heterogeneous (`ZodType<unknown>`); threading a per-capability input-wire type through them re-introduces the generic explosion the erasure was designed to remove, for no gain the schema package doesn't already give. Rejected — the erasure is correct; the fix is to import the schema directly, bypassing the erased kernel field.

## Decision

**Option A.** `@editorzero/schemas` is the single source of every capability's wire+internal contract. Capabilities and all surface adapters import from it; nothing re-declares a wire schema.

**Constraint — wire-preserving transforms only.** A shared API schema's `.transform()` may only map a JSON-representable wire value to a JSON-representable internal value (string → branded string; coerced number-string → number). A field that maps JSON to a non-JSON runtime type (Date, URL, class instance) may **not** be a shared API schema — that route needs explicit wire/internal separation. (Branded IDs and `z.coerce.number()` for query-string ints both qualify; both are proven.)

**Naming convention.** Mechanical, agent-derivable, coherence-checkable:
- Schema **values**: PascalCase + `Schema` suffix — `DocCreateInputSchema`, `DocCreateOutputSchema`, and the shared field schemas `DocIdInputSchema`/`DocIdOutputSchema`/`CollectionIdInputSchema`/… The suffix is *forced*: a transform-bearing schema has two distinct types (`z.input` ≠ `z.output`), so the value and a type cannot share one name.
- Inferred **types**, named from the capability contract (the dominant consumer is `Capability<DocCreateInput, DocCreateOutput>`, not raw HTTP JSON):
  - `<Cap>WireInput` = `z.input<typeof <Cap>InputSchema>` (wire request)
  - `<Cap>Input` = `z.output<typeof <Cap>InputSchema>` (branded handler input)
  - `<Cap>Output` = `z.output<typeof <Cap>OutputSchema>` (branded response)
  - `<Cap>WireOutput` = `z.input<typeof <Cap>OutputSchema>` — **reserved name**, not exported until a consumer needs the response-wire projection. Reserving the name forbids later `RawOutput`/`SerializedOutput`/`HttpOutput` synonyms.
- Derivation rule: capability id `doc.create` → `DocCreate{Input,Output}Schema` + `DocCreate{Input,Output}`. An agent or the coherence script can derive the export names from the id.
- Layout mirrors capabilities: `schemas/src/<domain>/<action>.ts`, imported `@editorzero/schemas/<domain>/<action>`. One file per action; shared sub-schemas in `schemas/src/shared/*` (`ids`, `visibility`, `audit`, `fields`).

**Dependency hygiene.** `@editorzero/schemas` depends only on `@editorzero/ids`, `@editorzero/scopes` (for `ROLES`/`SUBJECT_KINDS` enums), and `zod`. It must stay a light leaf: schemas type `doc.get`'s `blocks` as `z.array(z.unknown())` (the honest wire shape) rather than pulling `@editorzero/sync`'s `LooseBlock` (BlockNote/Yjs) into the type graph.

**Surface route patterns** (proven against real types, 2026-05-30): P1 body → `validator("json", <Cap>InputSchema)`; P2 single-id param → reuse `<Cap>InputSchema` as the param validator; P3 param+body merge → `<Cap>InputSchema.pick({...})` for each piece (`.pick()` preserves per-field transforms **and** `.strict()`); P4 query → numeric fields use `z.coerce.number()` so one schema validates HTTP query strings *and* CLI/MCP numbers.

## Consequences

- **Easier:** the wire contract per capability has exactly one definition; the route is forced honest by import, not by a "mirror rule." `OutputSchema.parse(result)` replaces the `result as …` cast — an honest `unknown`→typed narrowing that also runtime-guards dispatcher/contract drift (a mismatch is a ZodError → 500, not a silent lie). Zero `as` casts on the route surface. The same schemas are available to CLI/MCP/Web UI.
- **Harder / watch:** one more package in the graph; query-list capability inputs now accept coercible numeric strings (a deliberate wire-tolerance, symmetric with branded-ID wire strings); per-field UUIDv7 messages collapse to a generic "must be a UUIDv7" (the zod issue `path` identifies the field — no wire-visible regression, the envelope is `validation_failed` regardless).
- **Migration:** non-breaking to the kernel (`Capability<I,O>` unchanged), so the schema layer commits independently of the route migration.

## Revisit triggers

- A capability needs a field whose wire and internal forms differ by a **non-JSON** type (Date/URL/class) — that capability's route takes explicit wire/internal schemas; the shared schema holds only the JSON-preserving fields.
- The capability registry gains codegen (ADR 0029 "future state") — the schema modules become a codegen target keyed off the same registry; the naming derivation rule is the contract the generator emits.
- zod changes `z.input`/`z.output` inference for `.transform()` or `z.coerce` such that OpenAPI generation or `hc` typing degrades — re-spike before bumping.
