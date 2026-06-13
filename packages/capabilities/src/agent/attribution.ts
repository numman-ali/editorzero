/**
 * Agent-family attribution + visibility helpers (ADR 0044).
 *
 * `resolveHumanAnchor` is the family's instance of the established
 * `resolveCreatedBy` ladder (space.create / permission.grant /
 * doc.add_guest): user → self; agent → `acting_as` (the delegator)
 * else its own `owner_user_id`. The same resolved human serves as BOTH
 * `created_by` (attribution) and — for `agent.create` — the new row's
 * `owner_user_id`: an agent-created agent chains to the CREATING
 * agent's owner, so authority always grounds in a human and no
 * ownerless row is mintable by construction (Decision 2).
 *
 * `canSeeAllAgents` is the read-family visibility predicate ("admin-tier
 * sees all; a non-admin caller sees agents anchored to them" —
 * Decision 3). It reads only principal-local facts — user roles /
 * agent token scopes — the same facts the gate's static scope table is
 * built from; it is row-visibility POLICY for this family, not a
 * re-implementation of the dispatcher gate (which has already run).
 */

import { ValidationError } from "@editorzero/errors";
import type { UserId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";

export function resolveHumanAnchor(principal: Principal, capability: string): UserId {
  if (principal.kind === "user") return principal.id;
  if (principal.acting_as !== undefined) return principal.acting_as;
  if (principal.owner_user_id !== null) return principal.owner_user_id;
  throw new ValidationError({
    message:
      `${capability}: agent principal has neither \`acting_as\` nor \`owner_user_id\` set; ` +
      "cannot attribute the action to a human in v1.",
    issues: [
      {
        code: "unattributable_agent",
        message:
          "workspace-owned agent principal requires a delegated `acting_as` " +
          `(agent-auth token) or a non-null \`owner_user_id\` for ${capability}`,
        path: ["principal"],
      },
    ],
  });
}

export function canSeeAllAgents(principal: Principal): boolean {
  if (principal.kind === "user") {
    return principal.roles.includes("owner") || principal.roles.includes("admin");
  }
  return principal.scopes.includes("workspace:admin");
}
