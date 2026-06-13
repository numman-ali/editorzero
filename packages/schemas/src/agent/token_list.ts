/**
 * `agent.token_list` wire + internal contract (ADR 0034, ADR 0044).
 *
 * Per-agent listing (the Agents screen's token table). Revoked and
 * expired tokens are included — the lifecycle is part of the record;
 * none of the rows can verify anything (no `token_hash` on the shape).
 */

import { z } from "zod";

import { AgentTokenRowOutputSchema } from "../shared/agent";
import { AgentIdInputSchema } from "../shared/ids";

export const AgentTokenListInputSchema = z
  .object({
    agent_id: AgentIdInputSchema,
  })
  .strict();

export type AgentTokenListWireInput = z.input<typeof AgentTokenListInputSchema>;
export type AgentTokenListInput = z.output<typeof AgentTokenListInputSchema>;

export const AgentTokenListOutputSchema = z.object({
  tokens: z.array(AgentTokenRowOutputSchema),
});
export type AgentTokenListOutput = z.output<typeof AgentTokenListOutputSchema>;
