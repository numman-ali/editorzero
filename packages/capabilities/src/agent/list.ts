/**
 * `agent.list` — enumerate agents (ADR 0044 Decision 3).
 * `workspace:read` scope; owner-scoped visibility (the `agent.get`
 * rule, applied as a filter): admin-tier sees every agent, anyone else
 * sees agents anchored to them.
 *
 * Revoked rows are INCLUDED — the lifecycle is part of the record
 * (terminal-but-visible, Decision 2); `revoked_at` lets clients
 * partition. Unpaginated deliberately: minting is owner/admin-gated,
 * so workspace agent counts stay org-structure-sized (the space.list
 * argument).
 *
 * **Ordering.** `created_at ASC, id ASC` — registration order, stable
 * under same-tick creates (ids are v7); names are mutable and free on
 * revoke, so name-ordering would shuffle under renames.
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { CapabilityId } from "@editorzero/ids";
import {
  type AgentListInput,
  AgentListInputSchema,
  type AgentListOutput,
  AgentListOutputSchema,
} from "@editorzero/schemas/agent/list";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";
import { canSeeAllAgents, resolveHumanAnchor } from "./attribution";

const AGENT_LIST_ID = CapabilityId("agent.list");

export const agentList: Capability<AgentListInput, AgentListOutput> = {
  id: AGENT_LIST_ID,
  category: "read",
  summary: "List agents (admin-tier sees all; others see agents anchored to them).",
  input: AgentListInputSchema,
  output: AgentListOutputSchema,
  requires: ["workspace:read"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: () => ({ kind: "workspace" }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: AGENT_LIST_ID,
      required_scopes: ["workspace:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(AGENT_LIST_ID, error),
    // Constant bucket — no input, so identical calls collapse
    // (the space.list shape).
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      collapseKey: () => "agent.list",
    },
  },
  handler: async (ctx) => {
    let query = ctx.db
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
      .orderBy("created_at", "asc")
      .orderBy("id", "asc");

    if (!canSeeAllAgents(ctx.principal)) {
      query = query.where("owner_user_id", "=", resolveHumanAnchor(ctx.principal, "agent.list"));
    }
    const rows = await query.execute();

    return AgentListOutputSchema.parse({
      agents: rows.map((row) => ({
        agent_id: row.id,
        workspace_id: row.workspace_id,
        name: row.name,
        owner_user_id: row.owner_user_id,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        revoked_at: row.revoked_at,
      })),
    });
  },
};
