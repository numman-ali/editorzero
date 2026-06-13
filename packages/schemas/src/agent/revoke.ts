/**
 * `agent.revoke` wire + internal contract (ADR 0034, ADR 0044).
 *
 * Terminal: no un-revoke capability exists in the family (recovery is
 * recreation under a new id — Decision 2). The echo is the minimal
 * verb-specific pair (the `space.archive` posture): the id plus the
 * NON-NULL handler kill clock — which is also exactly what the audit
 * effect carries, so the builder reads it without a null dance. The
 * agent's tokens are NOT walked (a dead agent kills its tokens at
 * bearer resolution, by join — Decision 4).
 */

import { z } from "zod";

import { AgentIdInputSchema, AgentIdOutputSchema } from "../shared/ids";

export const AgentRevokeInputSchema = z
  .object({
    agent_id: AgentIdInputSchema,
  })
  .strict();

export type AgentRevokeWireInput = z.input<typeof AgentRevokeInputSchema>;
export type AgentRevokeInput = z.output<typeof AgentRevokeInputSchema>;

export const AgentRevokeOutputSchema = z.object({
  agent_id: AgentIdOutputSchema,
  /** The handler clock — the terminal kill anchor, never null on this echo. */
  revoked_at: z.number(),
});
export type AgentRevokeOutput = z.output<typeof AgentRevokeOutputSchema>;
