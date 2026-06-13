/**
 * `agent.token_list` — list one agent's tokens (ADR 0044 Decision 3).
 * `workspace:read` scope; visibility rides the AGENT'S visibility (the
 * `agent.get` rule): if the caller can see the agent, they see its
 * token rows — which carry display identity (prefix + last4), scopes,
 * tier, expiry, and lifecycle, and structurally CANNOT carry anything
 * verifiable (no `token_hash` on the output shape).
 *
 * Revoked agents' tokens list too (forensics — what credentials did
 * the dead identity hold); revoked/expired tokens are included and
 * client-partitioned via `revoked_at`/`expires_at`.
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type AgentTokenListInput,
  AgentTokenListInputSchema,
  type AgentTokenListOutput,
  AgentTokenListOutputSchema,
} from "@editorzero/schemas/agent/token_list";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";
import { canSeeAllAgents, resolveHumanAnchor } from "./attribution";
import { parseStoredScopes } from "./stored-scopes";

const AGENT_TOKEN_LIST_ID = CapabilityId("agent.token_list");

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

export const agentTokenList: Capability<AgentTokenListInput, AgentTokenListOutput> = {
  id: AGENT_TOKEN_LIST_ID,
  category: "read",
  summary: "List an agent's tokens (display identity + lifecycle; never anything verifiable).",
  input: AgentTokenListInputSchema,
  output: AgentTokenListOutputSchema,
  requires: ["workspace:read"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "agent", id: input.agent_id }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: AGENT_TOKEN_LIST_ID,
      required_scopes: ["workspace:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(AGENT_TOKEN_LIST_ID, error),
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      collapseKey: (input) => `agent.token_list:${agentIdBucket(input)}`,
    },
  },
  handler: async (ctx, input) => {
    // The agent's own visibility gates the listing (404 folds
    // out-of-scope and missing together — the agent.get posture).
    const agent = await ctx.db
      .selectFrom("agents")
      .select(["id", "owner_user_id"])
      .where("id", "=", input.agent_id)
      .executeTakeFirst();
    if (
      agent === undefined ||
      (!canSeeAllAgents(ctx.principal) &&
        agent.owner_user_id !== resolveHumanAnchor(ctx.principal, "agent.token_list"))
    ) {
      throw new NotFoundError({ subject_kind: "agent", subject_id: input.agent_id });
    }

    const rows = await ctx.db
      .selectFrom("agent_tokens")
      .select([
        "id",
        "workspace_id",
        "agent_id",
        "token_prefix",
        "last4",
        "scopes",
        "tier",
        "created_by",
        "created_at",
        "expires_at",
        "revoked_at",
      ])
      .where("agent_id", "=", input.agent_id)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();

    return AgentTokenListOutputSchema.parse({
      tokens: rows.map((row) => ({
        token_id: row.id,
        workspace_id: row.workspace_id,
        agent_id: row.agent_id,
        token_prefix: row.token_prefix,
        last4: row.last4,
        scopes: parseStoredScopes(row.scopes),
        tier: row.tier,
        created_by: row.created_by,
        created_at: row.created_at,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
      })),
    });
  },
};
