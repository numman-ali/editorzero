/**
 * `agent.token_revoke` wire + internal contract (ADR 0034, ADR 0044).
 *
 * Kills ONE token (the agent-wide kill is `agent.revoke`). Terminal —
 * same no-un-revoke rule as the agent row. The echo is the minimal
 * verb-specific pair (the `space.archive` posture): id + NON-NULL
 * handler kill clock, exactly what the audit effect carries.
 */

import { z } from "zod";

import { TokenIdInputSchema, TokenIdOutputSchema } from "../shared/ids";

export const AgentTokenRevokeInputSchema = z
  .object({
    token_id: TokenIdInputSchema,
  })
  .strict();

export type AgentTokenRevokeWireInput = z.input<typeof AgentTokenRevokeInputSchema>;
export type AgentTokenRevokeInput = z.output<typeof AgentTokenRevokeInputSchema>;

export const AgentTokenRevokeOutputSchema = z.object({
  token_id: TokenIdOutputSchema,
  /** The handler clock — the terminal kill anchor, never null on this echo. */
  revoked_at: z.number(),
});
export type AgentTokenRevokeOutput = z.output<typeof AgentTokenRevokeOutputSchema>;
