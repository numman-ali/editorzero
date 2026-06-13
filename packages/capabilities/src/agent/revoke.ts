/**
 * `agent.revoke` — kill an agent identity, terminally (ADR 0044
 * Decision 2). Metadata-only mutation; `agent:revoke` scope.
 *
 * **Terminal**: no un-revoke capability exists in the family — recovery
 * is recreation under a new id (the partial-unique index frees the
 * name). Revocation is a security action, not a trash operation, so
 * invariant 6 (recoverable soft-deletes) deliberately does not apply.
 *
 * **Cascades by construction, not by walking**: bearer resolution joins
 * `agents.revoked_at IS NULL`, so every token of a revoked agent stops
 * resolving the moment this row flips — token rows are NOT patched
 * (Decision 4; the replay walk pins the no-cascade projection). Live
 * WebSocket feeds close via the revocation tap when the WS increment
 * lands (Decision 5).
 *
 * **Re-revoke is refused** (`agent_revoked`), not echoed: a second
 * revoke would either lie about the kill time or silently re-stamp it —
 * both rewrite a forensic anchor. The first `revoked_at` is THE record.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { ConflictError, NotFoundError, ValidationError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type AgentRevokeInput,
  AgentRevokeInputSchema,
  type AgentRevokeOutput,
  AgentRevokeOutputSchema,
} from "@editorzero/schemas/agent/revoke";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const AGENT_REVOKE_ID = CapabilityId("agent.revoke");

export const agentRevoke: Capability<AgentRevokeInput, AgentRevokeOutput> = {
  id: AGENT_REVOKE_ID,
  category: "mutation",
  summary: "Revoke an agent identity, terminally (all its tokens stop resolving).",
  input: AgentRevokeInputSchema,
  output: AgentRevokeOutputSchema,
  requires: ["agent:revoke"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "agent", id: input.agent_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "agent.revoke",
      agent_id: output.agent_id,
      // The handler clock, verbatim — the forensic kill anchor (the
      // ADR 0017 deleted_at pattern applied to a terminal action).
      revoked_at: output.revoked_at,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: AGENT_REVOKE_ID,
      required_scopes: ["agent:revoke"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(AGENT_REVOKE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 1 — existence.
    const agent = await ctx.db
      .selectFrom("agents")
      .select(["id", "revoked_at"])
      .where("id", "=", input.agent_id)
      .executeTakeFirst();
    if (agent === undefined) {
      throw new NotFoundError({ subject_kind: "agent", subject_id: input.agent_id });
    }

    // Step 2 — terminal: re-revoke refused, the first kill time is THE record.
    if (agent.revoked_at !== null) {
      throw new ValidationError({
        message: "agent.revoke: the agent is already revoked; revocation is terminal.",
        issues: [
          {
            code: "agent_revoked",
            message: `revoked at ${agent.revoked_at}; recreate under a new id to replace it`,
            path: ["agent_id"],
          },
        ],
      });
    }

    // Step 3 — the kill. Liveness guard re-checked in the UPDATE: a
    // concurrent revoke between step 2 and here yields zero rows.
    const revoked = await ctx.db
      .updateTable("agents")
      .set({ revoked_at: now, updated_at: now })
      .where("id", "=", input.agent_id)
      .where("revoked_at", "is", null)
      .returning(["id"])
      .executeTakeFirst();
    if (revoked === undefined) {
      throw new ConflictError({
        message: "agent.revoke: the agent was revoked concurrently; re-read for the kill record.",
      });
    }

    return AgentRevokeOutputSchema.parse({ agent_id: revoked.id, revoked_at: now });
  },
};
