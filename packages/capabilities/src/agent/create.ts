/**
 * `agent.create` — mint an agent identity row (ADR 0044 Decision 2).
 * Metadata-only mutation; `agent:create` scope (owner/admin tier per
 * ROLE_SCOPES; agents may hold it — admin tier / custom mint).
 *
 * **Owner is resolved, never supplied.** The new row's `owner_user_id`
 * IS the resolved human anchor of the caller (user → self; agent →
 * `acting_as` ?? its own owner) — one rung, no input field, so no
 * caller can mint an agent owned by someone else and ownerless rows
 * are unmintable by construction. Workspace-owned automations are the
 * named deferred fork (Decision 2), waiting on `docs.created_by`
 * widening — not an input away.
 *
 * **Name uniqueness is live-rows-only** (`agents_name_unique` partial
 * index): a revoked agent FREES its name — recreate-under-new-id is
 * the recovery path, and the recreated agent conventionally reuses the
 * name. Pre-check → typed 409; the index is the race backstop.
 *
 * **The identity/credential split.** This row is *who*; it can do
 * NOTHING until `agent.token_mint` issues a credential (*may-do*).
 * Creating an agent is therefore a cheap, reversible-by-revoke act —
 * the security-sensitive step is the mint, which is where the
 * non-amplification rule lives.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { ConflictError } from "@editorzero/errors";
import { CapabilityId, generateAgentId } from "@editorzero/ids";
import {
  type AgentCreateInput,
  AgentCreateInputSchema,
  type AgentCreateOutput,
  AgentCreateOutputSchema,
} from "@editorzero/schemas/agent/create";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";
import { resolveHumanAnchor } from "./attribution";

const AGENT_CREATE_ID = CapabilityId("agent.create");

export const agentCreate: Capability<AgentCreateInput, AgentCreateOutput> = {
  id: AGENT_CREATE_ID,
  category: "mutation",
  summary: "Create an agent identity (no credential — tokens are minted separately).",
  input: AgentCreateInputSchema,
  output: AgentCreateOutputSchema,
  requires: ["agent:create"],
  agentAllowed: {},
  // UI trails (Agents screen — UI_PENDING in the parity ledger).
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: () => ({ kind: "agent" }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "agent.create",
      agent_id: output.agent_id,
      workspace_id: output.workspace_id,
      name: output.name,
      owner_user_id: output.owner_user_id,
      created_by: output.created_by,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: AGENT_CREATE_ID,
      required_scopes: ["agent:create"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(AGENT_CREATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const agent_id = generateAgentId();
    const workspace_id = ctx.tenant.workspace_id;
    const now = ctx.now();
    const anchor = resolveHumanAnchor(ctx.principal, "agent.create");

    // Live-name pre-check (typed 409 on the common path; the partial
    // unique index re-raises an interleaved race as `internal`).
    const existing = await ctx.db
      .selectFrom("agents")
      .select(["id"])
      .where("name", "=", input.name)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw new ConflictError({
        message:
          `agent.create: a live agent named "${input.name}" already exists in this workspace; ` +
          "names are unique among live agents (revoking an agent frees its name).",
      });
    }

    const row = {
      id: agent_id,
      workspace_id,
      name: input.name,
      owner_user_id: anchor,
      created_by: anchor,
      created_at: now,
      updated_at: now,
      revoked_at: null,
    };
    await ctx.db.insertInto("agents").values(row).execute();

    return AgentCreateOutputSchema.parse({
      agent_id,
      workspace_id,
      name: row.name,
      owner_user_id: row.owner_user_id,
      created_by: row.created_by,
      created_at: now,
      updated_at: now,
      revoked_at: null,
    });
  },
};
