/**
 * Permission gate (architecture.md §8.1 Layer 1).
 *
 * The gate is the dispatcher's injected adapter for "does this
 * principal have the required scopes for this capability on this
 * AccessPath". It is NOT the workspace membership query, the ACL
 * resolver, or the rate-limit bucket — those layer in behind a real
 * implementation when `@editorzero/db` ships. The interface stays
 * stable so surface adapters never special-case authorization.
 *
 * `GateResult` is a discriminated union rather than a boolean so a
 * deny carries the structured `DenyReason` the dispatcher hands to
 * `capability.audit.effectOnDeny`. Every deny produces an audit row
 * (§9.1 invariant 3a) without the dispatcher reaching into the gate's
 * internals.
 */

import type { DenyReason } from "@editorzero/errors";
import type { CapabilityId } from "@editorzero/ids";
import type { AccessPath, Principal } from "@editorzero/principal";
import { AGENT_SCOPE_TIERS, type Role, type Scope } from "@editorzero/scopes";

export type GateResult = { outcome: "allow" } | { outcome: "deny"; reason: DenyReason };

/**
 * Subset of a capability the gate reads. Deliberately narrower than
 * `AnyCapability<TEditor>` so the gate interface is invariant in
 * `TEditor` — the handler's editor type is irrelevant to authorization.
 * Any `Capability<I, O, TEditor>` is structurally assignable here.
 */
export interface CapabilityGateMeta {
  readonly id: CapabilityId;
  readonly requires: readonly Scope[];
  readonly humanOnly?: boolean;
}

export interface PermissionGate {
  check(
    principal: Principal,
    capability: CapabilityGateMeta,
    access: AccessPath,
  ): Promise<GateResult>;
}

// ── Default role → scope table ────────────────────────────────────────────

/**
 * Role → effective scopes for human principals. v1 is a static table
 * mirroring the default role tiers (§3.4). When the workspace-override
 * / collection-acl layers ship this becomes the "default" layer a
 * policy resolver composes with row-level grants.
 *
 * `owner` / `admin` get the full scope vocabulary. `guest` is
 * deliberately narrower than an agent's `read-only` tier — guests are
 * invited to specific docs and their reach is further narrowed by ACLs
 * once those land (§8.1 L1's `role_default ⊕ collection_acls` term).
 */
const ROLE_SCOPES: Readonly<Record<Role, readonly Scope[]>> = {
  owner: [
    "doc:read",
    "doc:write",
    "doc:delete",
    "doc:publish",
    "block:read",
    "block:write",
    "comment:read",
    "comment:write",
    "comment:resolve",
    "search:read",
    "workspace:read",
    "workspace:admin",
    "permission:grant",
    "permission:revoke",
    "agent:create",
    "agent:revoke",
    "admin",
  ],
  admin: [
    "doc:read",
    "doc:write",
    "doc:delete",
    "doc:publish",
    "block:read",
    "block:write",
    "comment:read",
    "comment:write",
    "comment:resolve",
    "search:read",
    "workspace:read",
    "workspace:admin",
    "permission:grant",
    "permission:revoke",
    "agent:create",
    "agent:revoke",
  ],
  member: [
    "doc:read",
    "doc:write",
    "block:read",
    "block:write",
    "comment:read",
    "comment:write",
    "comment:resolve",
    "search:read",
    "workspace:read",
  ],
  guest: ["doc:read", "block:read", "comment:read", "comment:write", "workspace:read"],
};

function effectiveScopes(principal: Principal): ReadonlySet<Scope> {
  if (principal.kind === "agent") return new Set(principal.scopes);
  const union = new Set<Scope>();
  for (const role of principal.roles) {
    for (const scope of ROLE_SCOPES[role]) union.add(scope);
  }
  return union;
}

/**
 * Scope-only gate. Checks, in order:
 *   1. Cross-workspace — `principal.workspace_id` equals `access.workspace_id`.
 *   2. `humanOnly` flag — agents are denied from human-only capabilities (§8.5).
 *   3. `requires` is a subset of the principal's effective scopes.
 *
 * NOT checked here (lands with `@editorzero/db`): workspace overrides,
 * collection / doc ACLs, agent↔delegator intersection for `acting_as`,
 * rate-limit buckets. A real `workspaceAwareGate` composes this gate's
 * scope check with the ACL resolvers.
 */
export function scopeOnlyGate(): PermissionGate {
  return {
    check: async (principal, capability, access) => {
      if (principal.workspace_id !== access.workspace_id) {
        return { outcome: "deny", reason: { kind: "cross_workspace" } };
      }

      if (capability.humanOnly === true && principal.kind === "agent") {
        return { outcome: "deny", reason: { kind: "human_only" } };
      }

      const principalScopes = effectiveScopes(principal);
      const missing: Scope[] = [];
      for (const required of capability.requires) {
        if (!principalScopes.has(required)) missing.push(required);
      }
      if (missing.length > 0) {
        return {
          outcome: "deny",
          reason: {
            kind: "missing_scope",
            required: missing,
            principal_scopes: [...principalScopes],
          },
        };
      }

      return { outcome: "allow" };
    },
  };
}

/**
 * Re-exported for tests that want to mint an agent with the `author`
 * tier without duplicating the list literal.
 */
export { AGENT_SCOPE_TIERS };
