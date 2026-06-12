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
import type { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import { type AccessPath, isDelegated, type Principal } from "@editorzero/principal";
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
  // `permission:grant` / `permission:revoke` on member is deliberately
  // coarse (ADR 0040 Step 8): the L1 scope only says "this verb exists
  // for you"; the REAL bound is the granting-authority ladder inside
  // the handler (`acl/ceiling.ts` — doc owner-tier / space owner-tier /
  // admin backstop). Same layering as doc:write + the placement gate:
  // members create docs everywhere the ceiling lets them, and members
  // share exactly the resources they have owner-tier standing on.
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
    "permission:grant",
    "permission:revoke",
  ],
  guest: ["doc:read", "block:read", "comment:read", "comment:write", "workspace:read"],
};

function roleScopeUnion(roles: readonly Role[]): Set<Scope> {
  const union = new Set<Scope>();
  for (const role of roles) {
    for (const scope of ROLE_SCOPES[role]) union.add(scope);
  }
  return union;
}

function effectiveScopes(principal: Principal): ReadonlySet<Scope> {
  if (principal.kind === "agent") return new Set(principal.scopes);
  return roleScopeUnion(principal.roles);
}

/**
 * Checks 1 + 2 (cross-workspace, humanOnly) — shared by both gates and
 * deliberately run BEFORE any DB lookup so a cross-tenant or
 * agent-on-human-only request never costs a delegator query. Returns
 * `null` when the structural checks pass.
 */
function structuralDeny(
  principal: Principal,
  capability: CapabilityGateMeta,
  access: AccessPath,
): GateResult | null {
  if (principal.workspace_id !== access.workspace_id) {
    return { outcome: "deny", reason: { kind: "cross_workspace" } };
  }
  if (capability.humanOnly === true && principal.kind === "agent") {
    return { outcome: "deny", reason: { kind: "human_only" } };
  }
  return null;
}

/** Check 3 — `requires ⊆ principalScopes`, with a structured shortfall. */
function scopeSubsetCheck(
  capability: CapabilityGateMeta,
  principalScopes: ReadonlySet<Scope>,
): GateResult {
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
}

/**
 * Scope-only gate. Checks, in order:
 *   1. Cross-workspace — `principal.workspace_id` equals `access.workspace_id`.
 *   2. `humanOnly` flag — agents are denied from human-only capabilities (§8.5).
 *   3. `requires` is a subset of the principal's effective scopes.
 *
 * NOT checked here: the `acting_as` ∩ delegator intersection
 * (`workspaceAwareGate` owns it — H8) and rate-limit buckets. Kept as
 * the dependency-free default for unit harnesses; production
 * composition (`createApiServer`) passes `workspaceAwareGate`.
 */
export function scopeOnlyGate(): PermissionGate {
  return {
    check: async (principal, capability, access) =>
      structuralDeny(principal, capability, access) ??
      scopeSubsetCheck(capability, effectiveScopes(principal)),
  };
}

// ── workspaceAwareGate (ADR 0040 Step 6) ──────────────────────────────────

/**
 * Role lookup for the delegator of an `acting_as` agent token.
 * Structurally identical to `@editorzero/db`'s `LoadRoles` — declared
 * locally so the gate stays a pure-policy module with an injected
 * seam instead of a db dependency; `createApiServer` passes the same
 * `createLoadRoles(driver)` callable the auth resolver uses (one role
 * source, two consumers).
 */
export type LoadDelegatorRoles = (
  workspaceId: WorkspaceId,
  userId: UserId,
) => Promise<readonly Role[] | null>;

export interface WorkspaceAwareGateDeps {
  readonly loadDelegatorRoles: LoadDelegatorRoles;
}

/**
 * The production gate (ADR 0040 Step 6). Same ordered checks as
 * `scopeOnlyGate`, plus the **`acting_as` ∩ delegator intersection**
 * (H8): a delegated agent's effective scopes are
 * `agent.scopes ∩ roleScopes(delegator)`, resolved against the LIVE
 * `workspace_members` row at check time — so removing the delegator
 * from the workspace instantly narrows every outstanding agent-auth
 * token to nothing (`delegator_not_member`), and demoting them
 * narrows the agent with them. Without this, `effectiveScopes`
 * takes the agent token's scope claim verbatim and a delegated token
 * outlives/escalates past its delegator.
 *
 * The doc-level ACL ceiling does NOT live here: per the F88 channel
 * (ADR 0040 H4/H10), row-level read authority is the handler-side
 * ceiling resolver (`@editorzero/capabilities` → `acl/ceiling.ts`)
 * throwing `PermissionDeniedError` post-parse. The gate stays
 * row-blind: principal × capability × AccessPath, one DB lookup at
 * most (the delegator's membership row).
 *
 * Check order: cross_workspace → human_only → delegation resolution →
 * scope arithmetic. The structural checks run first so a cross-tenant
 * or agent-on-human-only request never costs a DB lookup; delegation
 * resolution runs before scope arithmetic so a stale delegation is
 * reported as `delegator_not_member`, never a misleading
 * `missing_scope`.
 */
export function workspaceAwareGate(deps: WorkspaceAwareGateDeps): PermissionGate {
  return {
    check: async (principal, capability, access) => {
      const structural = structuralDeny(principal, capability, access);
      if (structural !== null) return structural;

      if (isDelegated(principal)) {
        const delegatorRoles = await deps.loadDelegatorRoles(
          principal.workspace_id,
          principal.acting_as,
        );
        if (delegatorRoles === null) {
          return { outcome: "deny", reason: { kind: "delegator_not_member" } };
        }
        const delegatorScopes = roleScopeUnion(delegatorRoles);
        const intersection = new Set(principal.scopes.filter((s) => delegatorScopes.has(s)));
        return scopeSubsetCheck(capability, intersection);
      }

      return scopeSubsetCheck(capability, effectiveScopes(principal));
    },
  };
}

/**
 * Re-exported for tests that want to mint an agent with the `author`
 * tier without duplicating the list literal.
 */
export { AGENT_SCOPE_TIERS };
