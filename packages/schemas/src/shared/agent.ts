/**
 * Shared agent vocabulary + the TWO agent row shapes (ADR 0034 SSOT;
 * ADR 0044).
 *
 * `AgentRowOutputSchema` is the single output shape every `agent.*`
 * lifecycle verb echoes — create echo, get, list element, update echo,
 * revoke echo (which carries the handler clock in `revoked_at`; every
 * other verb echoes `null` or the stored value). One definition, no
 * per-verb restatement (the `SpaceRowOutputSchema` pattern).
 *
 * `AgentTokenRowOutputSchema` is the token sibling — and it is the
 * SECRET BOUNDARY in schema form: there is NO `token_hash` field on
 * this shape, so no surface can echo the hash by construction (ADR
 * 0044 Decision 7: secrets are material, not state). The one place the
 * plaintext secret ever appears is `agent.token_mint`'s output, which
 * EXTENDS this row with the show-once `token` field — the audit effect
 * is built from the row fields only, so the secret cannot ride into
 * `audit_events` without re-adding the field by hand.
 *
 * `AgentTokenScopesInputSchema` encodes the mintable universe
 * (`AGENT_MINTABLE_SCOPES = SCOPES \ {"admin"}` — ADR 0044 Decision 1):
 * the literal `admin` scope is refused at the schema boundary for EVERY
 * caller, so "no agent token ever carries admin" is a parse-time fact,
 * not a handler check. The caller-relative half of the non-amplification
 * rule (agent callers mint ⊆ their own effective scopes) needs the
 * principal and lives in the `agent.token_mint` handler.
 */

import { AGENT_TOKEN_TIERS, SCOPES } from "@editorzero/scopes";
import { z } from "zod";

import {
  AgentIdOutputSchema,
  TokenIdOutputSchema,
  UserIdOutputSchema,
  WorkspaceIdOutputSchema,
} from "./ids";

export const AgentTokenTierSchema = z.enum(AGENT_TOKEN_TIERS);

/** Agent display name: 1–120 chars, trimmed (ADR 0044 Decision 2). */
export const AgentNameSchema = z
  .string()
  .trim()
  .min(1, "name must not be empty or whitespace-only")
  .max(120, "name must be at most 120 characters");

/**
 * Mint-time scope list (the `tier: "custom"` payload). Non-empty,
 * duplicate-free, and `admin`-free — the AGENT_MINTABLE_SCOPES bound,
 * stated as refinements over the full `SCOPES` enum so the error names
 * the offending literal instead of failing enum membership opaquely.
 */
export const AgentTokenScopesInputSchema = z
  .array(z.enum(SCOPES))
  .min(1, "scopes must name at least one scope")
  .refine((scopes) => !scopes.includes("admin"), {
    message:
      "the literal 'admin' scope is not agent-mintable (AGENT_MINTABLE_SCOPES, ADR 0044) — " +
      "every admin-scoped capability is humanOnly, so it would be dead weight on a token",
  })
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "scopes must not contain duplicates",
  });

export const AgentRowOutputSchema = z.object({
  agent_id: AgentIdOutputSchema,
  workspace_id: WorkspaceIdOutputSchema,
  name: AgentNameSchema,
  // NOT NULL in v1 — authority always grounds in a human (ADR 0044
  // Decision 2); owner liveness gates bearer resolution, not this echo.
  owner_user_id: UserIdOutputSchema,
  created_by: UserIdOutputSchema,
  created_at: z.number(),
  updated_at: z.number(),
  /** Epoch-ms the agent was revoked, or `null` if live. Terminal — never resets. */
  revoked_at: z.number().nullable(),
});

export type AgentRowOutput = z.output<typeof AgentRowOutputSchema>;

export const AgentTokenRowOutputSchema = z.object({
  token_id: TokenIdOutputSchema,
  workspace_id: WorkspaceIdOutputSchema,
  agent_id: AgentIdOutputSchema,
  /** First 12 chars of the full token (`ez_agent_` + 3) — display identity, never verifiable. */
  token_prefix: z.string(),
  last4: z.string(),
  /** The explicit minted list — the authority; `tier` is the recorded intent label. */
  scopes: z.array(z.enum(SCOPES)),
  tier: AgentTokenTierSchema,
  created_by: UserIdOutputSchema,
  created_at: z.number(),
  expires_at: z.number().nullable(),
  /** Epoch-ms the token was revoked, or `null` if live. Terminal — never resets. */
  revoked_at: z.number().nullable(),
});

export type AgentTokenRowOutput = z.output<typeof AgentTokenRowOutputSchema>;
