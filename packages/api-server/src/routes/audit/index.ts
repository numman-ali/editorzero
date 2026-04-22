/**
 * `audit` domain aggregator.
 *
 * Mirrors the `routes/workspaces/` + `routes/docs/` shape — a readonly
 * tuple of `defineOpenAPIRoute` products the trunk spreads into
 * `openapiRoutes([...])`. Middleware for `/audits/*` is attached at
 * the trunk (`createApiApp`), not here.
 */

import { get } from "./get";
import { list } from "./list";

export const auditRoutes = [get, list] as const;
