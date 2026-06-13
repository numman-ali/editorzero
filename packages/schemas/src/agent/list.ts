/**
 * `agent.list` wire + internal contract (ADR 0034, ADR 0044).
 *
 * No filters in v1: the list includes revoked rows (terminal but
 * visible — the lifecycle is part of the record) and the handler bounds
 * WHICH agents a non-admin caller sees (owner-bounded visibility).
 * Client-side filtering covers the rest until a real pagination need
 * shows up (workspace agent counts are small by construction — minting
 * is owner/admin-gated).
 */

import { z } from "zod";

import { AgentRowOutputSchema } from "../shared/agent";

export const AgentListInputSchema = z.object({}).strict();

export type AgentListWireInput = z.input<typeof AgentListInputSchema>;
export type AgentListInput = z.output<typeof AgentListInputSchema>;

export const AgentListOutputSchema = z.object({
  agents: z.array(AgentRowOutputSchema),
});
export type AgentListOutput = z.output<typeof AgentListOutputSchema>;
