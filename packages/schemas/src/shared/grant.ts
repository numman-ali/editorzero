/**
 * Grant vocabulary field schemas (ADR 0040 Step 3 / ADR 0034).
 *
 * One zod enum per `@editorzero/scopes` vocabulary — the Step-8
 * capability schemas (`permission.grant`/`revoke`, `space.*`,
 * `doc.add_guest`) and the Step-5 `docs.access_mode` column schema
 * compose these rather than re-stating the literal lists, so the
 * membership has exactly one source.
 *
 * `GrantRoleSchema` is DISTINCT from any workspace-role schema: the two
 * vocabularies share the word "owner" but mean different things
 * (per-resource grant vs workspace membership). ADR 0040 names the
 * conflation a drift hazard; `packages/scopes` pins both separately.
 */

import { ACCESS_MODES, GRANT_ROLES } from "@editorzero/scopes";
import { z } from "zod";

export const GrantRoleSchema = z.enum(GRANT_ROLES);

export const AccessModeSchema = z.enum(ACCESS_MODES);
