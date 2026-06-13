/**
 * `agent.get` wire + internal contract (ADR 0034, ADR 0044).
 *
 * Revoked agents resolve too — revocation is terminal but the row stays
 * visible (forensics + grants-to-dead-ids stay explicable); visibility
 * for non-admin callers is owner-bounded in the handler.
 */

import { z } from "zod";

import { AgentRowOutputSchema } from "../shared/agent";
import { AgentIdInputSchema } from "../shared/ids";

export const AgentGetInputSchema = z
  .object({
    agent_id: AgentIdInputSchema,
  })
  .strict();

export type AgentGetWireInput = z.input<typeof AgentGetInputSchema>;
export type AgentGetInput = z.output<typeof AgentGetInputSchema>;

export const AgentGetOutputSchema = AgentRowOutputSchema;
export type AgentGetOutput = z.output<typeof AgentGetOutputSchema>;
