/**
 * `infra` domain aggregator.
 *
 * Collects every `defineOpenAPIRoute` product under
 * `routes/infra/<capability>.ts` into a single readonly tuple so the
 * trunk (`src/app.ts`) can spread domain tuples into one
 * `openapiRoutes([...infraRoutes, ...docsRoutes, ...] as const)` call.
 * Per-route unit tests live co-located at `<capability>.unit.test.ts`;
 * this `index.ts` is the only one per domain — it is the grouping
 * aggregator, not a route itself.
 *
 * **Why the tuple is `as const` here.** `openapiRoutes`'s generic is
 * `<const Inputs extends readonly {...}[]>(inputs: Inputs) => ...` and
 * its `SchemaFromRoutes<Inputs, BasePath>` recurses
 * `[infer Head, ...infer Tail]` — tuple-shaped inference. For the
 * Schema merge (and therefore `hc<AppType>` RPC typing) to survive the
 * spread at the trunk, every intermediate aggregation must preserve
 * tuple element types. `as const` on this line does that; TypeScript
 * preserves element types through `[...tupleA, ...tupleB] as const`
 * spreads into a literal at the call site.
 *
 * **Adding a route.** Create `routes/infra/<name>.ts` that exports a
 * `defineOpenAPIRoute({..., addRoute: true })` value and its sibling
 * `<name>.unit.test.ts`; add the import here and append the
 * identifier to the tuple. The trunk needs no change — it consumes
 * `infraRoutes` as a black-box tuple.
 */

import { health } from "./health";

export const infraRoutes = [health] as const;
