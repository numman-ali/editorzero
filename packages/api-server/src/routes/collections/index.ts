/**
 * `collections` domain aggregator.
 *
 * Collects every `defineOpenAPIRoute` product under
 * `routes/collections/<capability>.ts` into a readonly tuple for the
 * trunk to spread into its `openapiRoutes([...]` call. Mirrors the
 * `routes/docs/` domain shape exactly; see that aggregator's header
 * for rationale on the `as const` load-bearing annotation and the
 * "add a capability → append to tuple" workflow.
 *
 * Middleware (`createPrincipalMiddleware` + `createDispatcherMiddleware`)
 * is mounted at the trunk on the `/collections/*` prefix, not here.
 */

import { create } from "./create";
import { del } from "./delete";
import { list } from "./list";
import { restore } from "./restore";
import { update } from "./update";

export const collectionsRoutes = [list, create, update, del, restore] as const;
