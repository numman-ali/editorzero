/**
 * `workspaces` domain aggregator.
 *
 * Mirrors the `routes/collections/` + `routes/docs/` shape — a
 * readonly tuple of `defineOpenAPIRoute` products the trunk spreads
 * into `openapiRoutes([...]`. Middleware for `/workspaces/*` is
 * attached at the trunk (`createApiApp`), not here.
 */

import { get } from "./get";
import { update } from "./update";

export const workspacesRoutes = [get, update] as const;
