/**
 * `createLoadRoles` — resolver-side Layer-1 role lookup (ADR 0024;
 * `@editorzero/auth` → `resolver.ts`).
 *
 * Returns a `loadRoles(workspace_id, user_id)` callable the Better
 * Auth resolver injects to turn a BA session into a principal with
 * the correct `roles: Role[]`. Queries `workspace_members` via
 * `driver.system()` — the resolver runs *before* a tenant context
 * exists, so the tenant-scoping plugin path is not available (and
 * `workspace_members` is not in `TENANT_SCOPED_TABLES` today for
 * the same reason; see `schema.ts`'s doc-block on the table).
 *
 * **Strict-on-missing.** Returns `null` when no active membership row
 * exists for the `(workspace_id, user_id)` pair. The resolver
 * translates that to 401 — the same posture as the existing
 * strict-on-missing-`workspaceId` branch at `resolver.ts:62–63`.
 * Rationale (ADR 0024): once the table exists, its absence for a
 * signed-in user is a structural error (the backfill migration must
 * have seeded a row), not a benign default. A silent
 * fallback-to-`member` would preserve the pre-ADR bug in a new shape.
 *
 * **Why a factory rather than reaching into the driver directly.**
 * Keeps `@editorzero/auth` ignorant of the Kysely query shape and
 * the `SystemDatabase` type — the coherence rule
 * `no-raw-kysely-outside-db` already pins those to this package. The
 * resolver takes a plain `(workspaceId, userId) => Promise<readonly
 * Role[] | null>` interface; the db package owns the implementation.
 *
 * **One active membership row per `(workspace_id, user_id)`.** The
 * composite PK + `deleted_at IS NULL` filter together guarantee at
 * most one row matches. Multi-role per user-in-workspace is not
 * anticipated (ADR 0024 §Mechanics); if it ever becomes needed, this
 * helper widens to `readonly Role[]` from many rows without changing
 * its contract.
 */

import type { UserId, WorkspaceId } from "@editorzero/ids";
import type { Role } from "@editorzero/scopes";
import type { Kysely } from "kysely";

import type { SystemDatabase } from "./schema";

export type LoadRoles = (
  workspaceId: WorkspaceId,
  userId: UserId,
) => Promise<readonly Role[] | null>;

/**
 * Narrow dependency — `createLoadRoles` only needs the `system()`
 * seam, not the full driver surface (`withSystemTx`, `close`, `exec`,
 * etc.). Typing against this interface rather than `SqliteDriver`
 * lets callers pass either driver shape without importing a backend-
 * specific type, and matches the slice's cross-backend DDL posture
 * (ADR 0023). Both `SqliteDriver` and `PostgresDriver` structurally
 * satisfy it via their `system()` method.
 */
export interface LoadRolesDriver {
  system(): Kysely<SystemDatabase>;
}

export function createLoadRoles(driver: LoadRolesDriver): LoadRoles {
  return async (workspaceId, userId) => {
    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select("role")
      .where("workspace_id", "=", workspaceId)
      .where("user_id", "=", userId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return null;
    return [row.role];
  };
}
