/**
 * `workspaces` domain aggregator.
 *
 * Mirrors the `routes/collections/` + `routes/docs/` shape — a
 * readonly tuple of `defineOpenAPIRoute` products the trunk spreads
 * into `openapiRoutes([...]`. Middleware for `/workspaces/*` is
 * attached at the trunk (`createApiApp`), not here.
 */

import { get } from "./get";
import { memberAdd } from "./member_add";
import { memberList } from "./member_list";
import { memberRemove } from "./member_remove";
import { memberUpdateRole } from "./member_update_role";
import { update } from "./update";

export const workspacesRoutes = [
  get,
  memberAdd,
  memberList,
  memberRemove,
  memberUpdateRole,
  update,
] as const;
