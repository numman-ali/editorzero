/**
 * `agent.update` wire + internal contract (ADR 0034, ADR 0044).
 *
 * Rename-only by design (Decision 2): the agent row is *who*, the token
 * is *may-do* — there is no other mutable identity field, so `name` is
 * required rather than an optional-patch shape (an empty patch would be
 * the only other expressible call, and it is a no-op the schema refuses
 * to encode).
 */

import { z } from "zod";

import { AgentNameSchema, AgentRowOutputSchema } from "../shared/agent";
import { AgentIdInputSchema } from "../shared/ids";

export const AgentUpdateBaseSchema = z
  .object({
    agent_id: AgentIdInputSchema,
    name: AgentNameSchema,
  })
  .strict();

export const AgentUpdateInputSchema = AgentUpdateBaseSchema;

/** Route path param (P3 split — `agent_id` rides the path). */
export const AgentUpdateParamSchema = AgentUpdateBaseSchema.pick({ agent_id: true });
/** Route JSON body (everything but the path param). */
export const AgentUpdateBodySchema = AgentUpdateBaseSchema.omit({ agent_id: true });

export type AgentUpdateWireInput = z.input<typeof AgentUpdateInputSchema>;
export type AgentUpdateInput = z.output<typeof AgentUpdateInputSchema>;

export const AgentUpdateOutputSchema = AgentRowOutputSchema;
export type AgentUpdateOutput = z.output<typeof AgentUpdateOutputSchema>;
