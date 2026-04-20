/**
 * `docs` domain aggregator.
 *
 * Collects every `defineOpenAPIRoute` product under
 * `routes/docs/<capability>.ts` into a single readonly tuple so the
 * trunk (`src/app.ts`) can spread domain tuples into one
 * `openapiRoutes([...infraRoutes, ...docsRoutes] as const)` call. Per-
 * route unit tests live co-located at `<capability>.unit.test.ts`;
 * this `index.ts` is the only one per domain — it is the grouping
 * aggregator, not a route itself.
 *
 * `as const` here is load-bearing — `openapiRoutes`'s generic is
 * `<const Inputs extends readonly {...}[]>(inputs: Inputs) => ...` and
 * `SchemaFromRoutes<Inputs, BasePath>` recurses `[infer Head, ...infer
 * Tail]`. Without the `as const` the tuple widens to `Array<...>` and
 * the per-element Schema merge collapses (→ `hc<AppType>` RPC typing
 * silently degrades to `unknown`).
 *
 * **Adding a capability.** Create `routes/docs/<name>.ts` with a
 * `defineOpenAPIRoute({ ..., addRoute: true })` export and its sibling
 * `<name>.unit.test.ts`; add the import here and append to the tuple.
 * The trunk needs no change.
 *
 * **Middleware is mounted at the trunk level**, not here. The trunk
 * factory (`createApiApp`) mounts `createPrincipalMiddleware` +
 * `createDispatcherMiddleware` on the `/docs/*` path prefix. Every
 * route in this tuple is a capability route that expects those to have
 * run before its handler.
 */

import { create } from "./create";
import { get } from "./get";
import { list } from "./list";
import { publish } from "./publish";

export const docsRoutes = [list, create, get, publish] as const;
