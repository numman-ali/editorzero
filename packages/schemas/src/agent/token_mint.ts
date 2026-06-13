/**
 * `agent.token_mint` wire + internal contract (ADR 0034, ADR 0044) —
 * the ONE capability whose output carries a secret, show-once.
 *
 * **Tier ↔ scopes contract** (Decision 1): `tier` names the mint
 * intent; the stored row always carries the EXPLICIT expanded list (no
 * tier indirection in rows — a later tier edit never re-scopes existing
 * tokens). So:
 *   - named tier (`read-only`/`author`/`editor`/`admin`) → `scopes`
 *     must be ABSENT; the handler expands `AGENT_SCOPE_TIERS[tier]`.
 *   - `tier: "custom"` → `scopes` is REQUIRED (the explicit list).
 * A named tier WITH a scopes list is refused as ambiguous intent rather
 * than silently preferring either.
 *
 * The schema half of non-amplification rides
 * `AgentTokenScopesInputSchema` (no literal `admin`, ever); the
 * caller-relative half (agent callers mint ⊆ their own scopes) needs
 * the principal and lives in the handler.
 *
 * `expires_at` is `z.coerce.number()` — the one field here a CLI flag
 * delivers as a string (ADR 0034's one-schema-many-boundaries rule);
 * `.nullable()` short-circuits before coercion so JSON `null` survives.
 * Future-ness is a handler check (the schema has no clock).
 *
 * **Output**: `AgentTokenRowOutputSchema` extended with the show-once
 * plaintext `token`. The audit effect is built from the ROW fields, so
 * the secret cannot reach `audit_events` without re-adding the field by
 * hand — the structural exclusion ADR 0044 Decision 3 pins.
 */

import { z } from "zod";

import {
  AgentTokenRowOutputSchema,
  AgentTokenScopesInputSchema,
  AgentTokenTierSchema,
} from "../shared/agent";
import { AgentIdInputSchema } from "../shared/ids";

export const AgentTokenMintBaseSchema = z
  .object({
    agent_id: AgentIdInputSchema,
    tier: AgentTokenTierSchema,
    scopes: AgentTokenScopesInputSchema.optional(),
    expires_at: z.coerce
      .number()
      .int("expires_at must be an integer epoch-ms timestamp")
      .positive("expires_at must be a positive epoch-ms timestamp")
      .nullable()
      .default(null),
  })
  .strict();

export const AgentTokenMintInputSchema = AgentTokenMintBaseSchema.superRefine((input, ctx) => {
  if (input.tier === "custom" && input.scopes === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["scopes"],
      message: "tier 'custom' requires an explicit scopes list",
    });
  }
  if (input.tier !== "custom" && input.scopes !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["scopes"],
      message:
        `tier '${input.tier}' expands to its named scope set — passing scopes alongside it is ` +
        "ambiguous intent; use tier 'custom' to mint an explicit list",
    });
  }
});

/** Route path param (P3 split — `agent_id` rides the path). */
export const AgentTokenMintParamSchema = AgentTokenMintBaseSchema.pick({ agent_id: true });
/**
 * Route JSON body — everything but the path param. The tier↔scopes
 * cross-field refinement re-runs on the MERGED object in the route via
 * `AgentTokenMintInputSchema` (the body alone cannot see `agent_id`,
 * and the refinement does not touch it, so validating the body shape
 * here and the full input in the handler keeps one rule, one place).
 */
export const AgentTokenMintBodySchema = AgentTokenMintBaseSchema.omit({ agent_id: true });

export type AgentTokenMintWireInput = z.input<typeof AgentTokenMintInputSchema>;
export type AgentTokenMintInput = z.output<typeof AgentTokenMintInputSchema>;

export const AgentTokenMintOutputSchema = AgentTokenRowOutputSchema.extend({
  /**
   * The plaintext bearer secret (`ez_agent_` + 43 base62 chars) —
   * SHOWN ONCE in this output and never stored, logged, or audited.
   * Lose it, revoke + re-mint.
   */
  token: z.string(),
});
export type AgentTokenMintOutput = z.output<typeof AgentTokenMintOutputSchema>;
