/**
 * `agent.token_mint` — issue a bearer credential for an agent (ADR 0044
 * Decisions 1 + 3). Metadata-only mutation; `agent:create` scope. THE
 * security-critical verb of the family: identity is cheap, credentials
 * are where every bound lives.
 *
 * **Tier → scopes**: named tiers expand `AGENT_SCOPE_TIERS[tier]` to an
 * EXPLICIT stored list (no tier indirection in rows — a later tier edit
 * never re-scopes existing tokens); `custom` takes the schema-validated
 * list. Both lanes are inside `AGENT_MINTABLE_SCOPES` by construction:
 * the schema refuses literal `admin` on custom lists, and the scopes
 * unit suite pins every named tier ⊆ mintable.
 *
 * **Non-amplification, caller-relative half (Codex MUST-FIX 1)**: when
 * the MINTER is an agent, requested scopes must be ⊆ the caller's own
 * scopes — a narrow agent holding `agent:create` must not self-amplify
 * by minting a broader token. ADR 0044 states the rule against
 * *effective* scopes, which for every v1-authenticatable agent is its
 * token claim verbatim (autonomous agents only — the resolver mints no
 * delegated principals until delegated credentials land; the gate's H8
 * intersection bounds delegated AUTHORITY if a fabricated one appears
 * in a harness). Human callers mint anything in the mintable universe.
 *
 * **Show-once**: the output carries the plaintext `token`; the audit
 * effect is built from the ROW fields and the row stores only the
 * SHA-256 — the secret exists nowhere else, ever (Decision 3's
 * structural exclusion; the unit pin asserts it).
 *
 * **expires_at** must sit in the handler's future (the schema has no
 * clock); `null` = non-expiring.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError, ValidationError } from "@editorzero/errors";
import { CapabilityId, generateTokenId } from "@editorzero/ids";
import {
  type AgentTokenMintInput,
  AgentTokenMintInputSchema,
  type AgentTokenMintOutput,
  AgentTokenMintOutputSchema,
} from "@editorzero/schemas/agent/token_mint";
import { AGENT_SCOPE_TIERS, type Scope } from "@editorzero/scopes";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";
import { resolveHumanAnchor } from "./attribution";
import { mintAgentToken } from "./token-crypto";

const AGENT_TOKEN_MINT_ID = CapabilityId("agent.token_mint");

export const agentTokenMint: Capability<AgentTokenMintInput, AgentTokenMintOutput> = {
  id: AGENT_TOKEN_MINT_ID,
  category: "mutation",
  summary: "Mint a bearer token for an agent — the secret is shown once, in this output only.",
  input: AgentTokenMintInputSchema,
  output: AgentTokenMintOutputSchema,
  requires: ["agent:create"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "agent", id: input.agent_id }),
    // Built from ROW fields only — `output.token` (the secret) is not
    // read here, so it cannot reach audit_events without re-adding the
    // field by hand. The effect-shape unit pin guards the union side.
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "agent.token_mint",
      token_id: output.token_id,
      agent_id: output.agent_id,
      workspace_id: output.workspace_id,
      token_prefix: output.token_prefix,
      last4: output.last4,
      scopes: output.scopes,
      tier: output.tier,
      expires_at: output.expires_at,
      created_by: output.created_by,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: AGENT_TOKEN_MINT_ID,
      required_scopes: ["agent:create"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(AGENT_TOKEN_MINT_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 1 — the target agent exists and is LIVE (a dead identity
    // must not regain credentials; recreate-under-new-id instead).
    const agent = await ctx.db
      .selectFrom("agents")
      .select(["id", "revoked_at"])
      .where("id", "=", input.agent_id)
      .executeTakeFirst();
    if (agent === undefined) {
      throw new NotFoundError({ subject_kind: "agent", subject_id: input.agent_id });
    }
    if (agent.revoked_at !== null) {
      throw new ValidationError({
        message:
          "agent.token_mint: the agent is revoked; revocation is terminal — no new credentials.",
        issues: [
          {
            code: "agent_revoked",
            message: "a revoked agent cannot be re-credentialed; create a new agent instead",
            path: ["agent_id"],
          },
        ],
      });
    }

    // Step 2 — resolve the scope list (tier expansion / custom).
    let scopes: readonly Scope[];
    if (input.tier === "custom") {
      if (input.scopes === undefined) {
        // Schema-unreachable (the superRefine refuses it); typed
        // defense so a future schema reshape fails loudly, not as a
        // token with zero scopes.
        throw new ValidationError({
          message: "agent.token_mint: tier 'custom' requires an explicit scopes list.",
          issues: [
            { code: "custom", message: "scopes is required for tier 'custom'", path: ["scopes"] },
          ],
        });
      }
      scopes = input.scopes;
    } else {
      scopes = AGENT_SCOPE_TIERS[input.tier];
    }

    // Step 3 — non-amplification, caller-relative half: an agent mints
    // at most what it holds (see header for the v1 effective-scopes
    // reading). Humans skip this rung — the mintable universe (already
    // schema-enforced for custom lists) is their only bound.
    if (ctx.principal.kind === "agent") {
      const held = new Set<Scope>(ctx.principal.scopes);
      const exceeding = scopes.filter((s) => !held.has(s));
      if (exceeding.length > 0) {
        throw new ValidationError({
          message:
            "agent.token_mint: an agent caller cannot mint scopes beyond its own " +
            `(non-amplification, ADR 0044) — exceeding: ${exceeding.join(", ")}.`,
          issues: [
            {
              code: "scope_amplification",
              message: `requested scopes exceed the calling agent's own: ${exceeding.join(", ")}`,
              path: ["scopes"],
            },
          ],
        });
      }
    }

    // Step 4 — expiry sanity (the schema has no clock).
    if (input.expires_at !== null && input.expires_at <= now) {
      throw new ValidationError({
        message: "agent.token_mint: expires_at must be in the future (or null for non-expiring).",
        issues: [
          {
            code: "expires_in_past",
            message: `expires_at ${input.expires_at} is not after the mint time ${now}`,
            path: ["expires_at"],
          },
        ],
      });
    }

    // Step 5 — mint + store. The plaintext lives in `minted.token` and
    // the return value; the row gets the SHA-256. UNIQUE(token_hash) is
    // the structural-corruption tripwire (a collision over 256-bit
    // entropy is not a code path).
    const minted = mintAgentToken();
    const token_id = generateTokenId();
    const workspace_id = ctx.tenant.workspace_id;
    const row = {
      id: token_id,
      workspace_id,
      agent_id: input.agent_id,
      token_hash: minted.token_hash,
      token_prefix: minted.token_prefix,
      last4: minted.last4,
      scopes: JSON.stringify(scopes),
      tier: input.tier,
      created_by: resolveHumanAnchor(ctx.principal, "agent.token_mint"),
      created_at: now,
      expires_at: input.expires_at,
      revoked_at: null,
    };
    await ctx.db.insertInto("agent_tokens").values(row).execute();

    return AgentTokenMintOutputSchema.parse({
      token_id,
      workspace_id,
      agent_id: input.agent_id,
      token_prefix: row.token_prefix,
      last4: row.last4,
      scopes,
      tier: row.tier,
      created_by: row.created_by,
      created_at: now,
      expires_at: row.expires_at,
      revoked_at: null,
      token: minted.token,
    });
  },
};
