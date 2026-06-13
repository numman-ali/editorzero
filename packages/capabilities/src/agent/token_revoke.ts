/**
 * `agent.token_revoke` — kill one bearer token, terminally (ADR 0044
 * Decision 3). Metadata-only mutation; `agent:revoke` scope.
 *
 * One token, not the agent: rotation is revoke + re-mint under the
 * same identity. Same terminal posture as `agent.revoke` — re-revoke
 * refused, the first kill clock is THE record. Live WS feeds riding
 * this token close via the revocation tap when the WS increment lands
 * (Decision 5).
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
  type AgentTokenRevokeInput,
  AgentTokenRevokeInputSchema,
  type AgentTokenRevokeOutput,
  AgentTokenRevokeOutputSchema,
} from "@editorzero/schemas/agent/token_revoke";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const AGENT_TOKEN_REVOKE_ID = CapabilityId("agent.token_revoke");

export const agentTokenRevoke: Capability<AgentTokenRevokeInput, AgentTokenRevokeOutput> = {
  id: AGENT_TOKEN_REVOKE_ID,
  category: "mutation",
  summary: "Revoke one agent bearer token, terminally (rotation = revoke + re-mint).",
  input: AgentTokenRevokeInputSchema,
  output: AgentTokenRevokeOutputSchema,
  requires: ["agent:revoke"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "token", id: input.token_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "agent.token_revoke",
      token_id: output.token_id,
      revoked_at: output.revoked_at,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: AGENT_TOKEN_REVOKE_ID,
      required_scopes: ["agent:revoke"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(AGENT_TOKEN_REVOKE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 1 — existence.
    const token = await ctx.db
      .selectFrom("agent_tokens")
      .select(["id", "revoked_at"])
      .where("id", "=", input.token_id)
      .executeTakeFirst();
    if (token === undefined) {
      throw new NotFoundError({ subject_kind: "token", subject_id: input.token_id });
    }

    // Step 2 — terminal: the first kill clock is THE record.
    if (token.revoked_at !== null) {
      throw new ValidationError({
        message: "agent.token_revoke: the token is already revoked; revocation is terminal.",
        issues: [
          {
            code: "token_revoked",
            message: `revoked at ${token.revoked_at}; mint a new token to replace it`,
            path: ["token_id"],
          },
        ],
      });
    }

    // Step 3 — the kill (liveness re-checked; concurrent revoke → 409).
    const revoked = await ctx.db
      .updateTable("agent_tokens")
      .set({ revoked_at: now })
      .where("id", "=", input.token_id)
      .where("revoked_at", "is", null)
      .returning(["id"])
      .executeTakeFirst();
    if (revoked === undefined) {
      throw new ConflictError({
        message:
          "agent.token_revoke: the token was revoked concurrently; re-read for the kill record.",
      });
    }

    return AgentTokenRevokeOutputSchema.parse({ token_id: revoked.id, revoked_at: now });
  },
};
