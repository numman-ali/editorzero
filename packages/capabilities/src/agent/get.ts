/**
 * `agent.get` — read one agent row (ADR 0044 Decision 3).
 * `workspace:read` scope; the REAL bound is owner-scoped visibility:
 * admin-tier callers (user owner/admin role; agent holding
 * `workspace:admin`) see every agent, anyone else sees only agents
 * anchored to them — enforced as 404, not 403, so probing ids reveals
 * nothing a missing row wouldn't.
 *
 * Revoked agents RESOLVE (revocation is terminal but visible —
 * forensics, and grants referencing the dead id stay explicable).
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type AgentGetInput,
  AgentGetInputSchema,
  type AgentGetOutput,
  AgentGetOutputSchema,
} from "@editorzero/schemas/agent/get";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";
import { canSeeAllAgents, resolveHumanAnchor } from "./attribution";

const AGENT_GET_ID = CapabilityId("agent.get");

// `CollapsePolicy.collapseKey` is `(input: unknown) => string` (type
// erasure at the audit boundary). Narrowed via `in`, never a cast; the
// fallback bucket keeps the function total — the audit writer must not
// throw — and only an unvalidated harness input could ever reach it.
function agentIdBucket(input: unknown): string {
  return typeof input === "object" &&
    input !== null &&
    "agent_id" in input &&
    typeof input.agent_id === "string"
    ? input.agent_id
    : "unvalidated";
}

export const agentGet: Capability<AgentGetInput, AgentGetOutput> = {
  id: AGENT_GET_ID,
  category: "read",
  summary: "Read one agent (admin-tier sees all; others see agents anchored to them).",
  input: AgentGetInputSchema,
  output: AgentGetOutputSchema,
  requires: ["workspace:read"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "agent", id: input.agent_id }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: AGENT_GET_ID,
      required_scopes: ["workspace:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(AGENT_GET_ID, error),
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      collapseKey: (input) => `agent.get:${agentIdBucket(input)}`,
    },
  },
  handler: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom("agents")
      .select([
        "id",
        "workspace_id",
        "name",
        "owner_user_id",
        "created_by",
        "created_at",
        "updated_at",
        "revoked_at",
      ])
      .where("id", "=", input.agent_id)
      .executeTakeFirst();

    // Visibility folds into existence: out-of-scope reads 404 (never
    // 403 — an id-prober learns nothing a missing row wouldn't say).
    if (
      row === undefined ||
      (!canSeeAllAgents(ctx.principal) &&
        row.owner_user_id !== resolveHumanAnchor(ctx.principal, "agent.get"))
    ) {
      throw new NotFoundError({ subject_kind: "agent", subject_id: input.agent_id });
    }

    return AgentGetOutputSchema.parse({
      agent_id: row.id,
      workspace_id: row.workspace_id,
      name: row.name,
      owner_user_id: row.owner_user_id,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      revoked_at: row.revoked_at,
    });
  },
};
