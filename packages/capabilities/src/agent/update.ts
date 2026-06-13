/**
 * `agent.update` — rename an agent (ADR 0044 Decision 2: rename-only).
 * Metadata-only mutation; `agent:create` scope (the mint-side scope
 * gates identity shaping; `agent:revoke` is the kill-side).
 *
 * **Refused on a revoked row** (`agent_revoked`): revocation is
 * terminal — a dead identity's record stays as it died; renaming it
 * would rewrite forensic history. (404 = the row does not exist; the
 * mutation family is scope-bound, not visibility-folded — holding
 * `agent:create` is fleet-level authority, unlike the owner-scoped
 * read family.)
 *
 * **Live-name uniqueness** excludes self (an idempotent same-name
 * rename echoes without conflict) — pre-check → typed 409; the partial
 * unique index is the race backstop.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { ConflictError, NotFoundError, ValidationError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type AgentUpdateInput,
  AgentUpdateInputSchema,
  type AgentUpdateOutput,
  AgentUpdateOutputSchema,
} from "@editorzero/schemas/agent/update";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const AGENT_UPDATE_ID = CapabilityId("agent.update");

export const agentUpdate: Capability<AgentUpdateInput, AgentUpdateOutput> = {
  id: AGENT_UPDATE_ID,
  category: "mutation",
  summary: "Rename an agent (rename-only; identity is otherwise immutable).",
  input: AgentUpdateInputSchema,
  output: AgentUpdateOutputSchema,
  requires: ["agent:create"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "agent", id: input.agent_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "agent.update",
      agent_id: output.agent_id,
      patch: { name: output.name },
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: AGENT_UPDATE_ID,
      required_scopes: ["agent:create"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(AGENT_UPDATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 1 — existence (404 first, before any state inspection).
    const agent = await ctx.db
      .selectFrom("agents")
      .select([
        "id",
        "name",
        "owner_user_id",
        "created_by",
        "created_at",
        "updated_at",
        "revoked_at",
      ])
      .where("id", "=", input.agent_id)
      .executeTakeFirst();
    if (agent === undefined) {
      throw new NotFoundError({ subject_kind: "agent", subject_id: input.agent_id });
    }

    // Step 2 — terminal-revocation refusal.
    if (agent.revoked_at !== null) {
      throw new ValidationError({
        message:
          "agent.update: the agent is revoked; revocation is terminal — recreate under a new id.",
        issues: [
          {
            code: "agent_revoked",
            message: "a revoked agent's record stays as it died; create a new agent instead",
            path: ["agent_id"],
          },
        ],
      });
    }

    // Step 3 — idempotent same-name echo: zero writes, stored
    // timestamps verbatim (echoing `now` would claim a write that
    // never happened). The re-emitted `agent.update` effect patches
    // the name to its current value — replay-convergent, the
    // permission.grant idempotent-re-grant posture.
    if (agent.name === input.name) {
      return AgentUpdateOutputSchema.parse({
        agent_id: agent.id,
        workspace_id: ctx.tenant.workspace_id,
        name: agent.name,
        owner_user_id: agent.owner_user_id,
        created_by: agent.created_by,
        created_at: agent.created_at,
        updated_at: agent.updated_at,
        revoked_at: null,
      });
    }

    // Step 4 — live-name pre-check, self excluded.
    const collision = await ctx.db
      .selectFrom("agents")
      .select(["id"])
      .where("name", "=", input.name)
      .where("revoked_at", "is", null)
      .where("id", "!=", input.agent_id)
      .executeTakeFirst();
    if (collision !== undefined) {
      throw new ConflictError({
        message:
          `agent.update: a live agent named "${input.name}" already exists in this workspace; ` +
          "names are unique among live agents.",
      });
    }

    const updated = await ctx.db
      .updateTable("agents")
      .set({ name: input.name, updated_at: now })
      .where("id", "=", input.agent_id)
      .where("revoked_at", "is", null)
      .returning([
        "id",
        "workspace_id",
        "name",
        "owner_user_id",
        "created_by",
        "created_at",
        "updated_at",
        "revoked_at",
      ])
      .executeTakeFirst();
    if (updated === undefined) {
      // A concurrent revoke landed between step 2 and here.
      throw new ConflictError({
        message: "agent.update: the agent was revoked concurrently; re-read and retry.",
      });
    }

    return AgentUpdateOutputSchema.parse({
      agent_id: updated.id,
      workspace_id: updated.workspace_id,
      name: updated.name,
      owner_user_id: updated.owner_user_id,
      created_by: updated.created_by,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
      revoked_at: updated.revoked_at,
    });
  },
};
