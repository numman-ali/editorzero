/**
 * `agent.create` wire + internal contract (ADR 0034, ADR 0044) — the
 * single source the capability, the API route, and every other surface
 * derive from.
 *
 * `name` is the only input: `owner_user_id` is NOT a field — the owner
 * is the resolved human behind the caller (user → self; agent →
 * `acting_as` ?? its own `owner_user_id`), so authority always chains
 * to a human and no caller can mint an agent owned by someone else.
 * Workspace-owned (ownerless) agents are the deferred fork ADR 0044
 * Decision 2 records, not an input away.
 */

import { z } from "zod";

import { AgentNameSchema, AgentRowOutputSchema } from "../shared/agent";

export const AgentCreateInputSchema = z
  .object({
    name: AgentNameSchema,
  })
  .strict();

export type AgentCreateWireInput = z.input<typeof AgentCreateInputSchema>;
export type AgentCreateInput = z.output<typeof AgentCreateInputSchema>;

export const AgentCreateOutputSchema = AgentRowOutputSchema;
export type AgentCreateOutput = z.output<typeof AgentCreateOutputSchema>;
