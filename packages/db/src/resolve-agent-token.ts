/**
 * `createResolveAgentToken` — resolver-side bearer-token lookup (ADR
 * 0044 Decision 4; the api-server composition root assembles the
 * `AgentPrincipal` around it, just as `@editorzero/auth`'s resolver
 * assembles `UserPrincipal` around `createLoadRoles`).
 *
 * Returns a `resolveAgentToken(tokenHash)` callable the composition
 * injects into the HTTP principal middleware's bearer arm. The caller
 * presents `Authorization: Bearer ez_agent_…`; the composition hashes
 * the secret (SHA-256 via `@editorzero/capabilities` — which sits ABOVE
 * this package, so the hashing stays out of here) and hands us the
 * digest. We resolve it to the row data an agent principal needs, or
 * `null`.
 *
 * **Why a factory + the `system()` seam, mirroring `createLoadRoles`.**
 * The resolver runs *before* a tenant context exists (it is how the
 * principal — and thus the context — gets minted), so the tenant-scoping
 * plugin path is unavailable; we query the raw `system()` connection and
 * are explicit about `workspace_id` in every join. Typing against the
 * narrow `{ system() }` seam keeps `@editorzero/auth` / `@editorzero/
 * api-server` ignorant of the Kysely query shape (`no-raw-kysely-
 * outside-db` pins that here).
 *
 * **Four liveness conjuncts, all enforced in one indexed lookup**
 * (ADR 0044, schema docstring on `agent_tokens`):
 *   1. `token_hash` matches under its GLOBAL unique index — full-digest
 *      lookup over 256-bit entropy; a single row or none.
 *   2. The token is not revoked and not expired (`revoked_at IS NULL`
 *      and `expires_at IS NULL OR expires_at > now`). Revocation is
 *      terminal; the row lingers but stops resolving.
 *   3. The owning agent is live (`agents.revoked_at IS NULL`).
 *   4. The owner is STILL a live workspace member (inner-join
 *      `workspace_members` on the owner + `deleted_at IS NULL`). A
 *      removed member's agents stop authenticating with no cascade
 *      touching the agent/token rows — owner liveness gates auth.
 * Any conjunct failing yields no row → `null` → the composition's 401.
 *
 * **Read-only.** No `last_used_at` write, no mutation of any kind — the
 * audit log IS the usage record (ADR 0044). Authz resolvers never write
 * (see the standing rule on principal resolution).
 *
 * **Scopes returned RAW.** `scopes` is the stored JSON column verbatim;
 * the composition parses it through `parseStoredScopes` (the single
 * closed-vocabulary parser, which lives in `@editorzero/capabilities`
 * above this package). Keeping the parse out of here preserves the
 * layering AND routes every reader through the one parser that throws on
 * corruption rather than silently filtering.
 */

import type { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { Kysely } from "kysely";

import type { SystemDatabase } from "./schema";

/**
 * The row data an `AgentPrincipal` is built from. Branded by the schema
 * column types Kysely carries through the select — no constructors, no
 * casts. `scopes` is the raw `agent_tokens.scopes` JSON string (see the
 * module docstring on why the parse happens in the composition layer).
 */
export interface AgentTokenResolution {
  readonly token_id: TokenId;
  readonly agent_id: AgentId;
  readonly workspace_id: WorkspaceId;
  readonly owner_user_id: UserId;
  readonly scopes: string;
}

export type ResolveAgentToken = (tokenHash: string) => Promise<AgentTokenResolution | null>;

/**
 * Narrow dependency — only the `system()` seam, mirroring
 * `LoadRolesDriver`. Both `SqliteDriver` and `PostgresDriver`
 * structurally satisfy it; defined locally (rather than imported) so
 * each resolver module documents its own dependency, matching the
 * `load-roles.ts` precedent.
 */
export interface ResolveAgentTokenDriver {
  system(): Kysely<SystemDatabase>;
}

export function createResolveAgentToken(
  driver: ResolveAgentTokenDriver,
  now: () => number = Date.now,
): ResolveAgentToken {
  return async (tokenHash) => {
    const ts = now();
    const row = await driver
      .system()
      .selectFrom("agent_tokens as at")
      .innerJoin("agents as a", (join) =>
        join.onRef("a.id", "=", "at.agent_id").onRef("a.workspace_id", "=", "at.workspace_id"),
      )
      .innerJoin("workspace_members as wm", (join) =>
        join
          .onRef("wm.user_id", "=", "a.owner_user_id")
          .onRef("wm.workspace_id", "=", "a.workspace_id"),
      )
      .select([
        "at.id as token_id",
        "at.agent_id as agent_id",
        "at.workspace_id as workspace_id",
        "at.scopes as scopes",
        "a.owner_user_id as owner_user_id",
      ])
      .where("at.token_hash", "=", tokenHash)
      .where("at.revoked_at", "is", null)
      .where("a.revoked_at", "is", null)
      .where("wm.deleted_at", "is", null)
      .where((eb) => eb.or([eb("at.expires_at", "is", null), eb("at.expires_at", ">", ts)]))
      .executeTakeFirst();
    return row ?? null;
  };
}
