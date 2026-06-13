/**
 * Agent family — audit projections + registry facts, in one sweep.
 *
 * The per-verb suites pin handler semantics and the allow-effects of
 * the five mutators; THIS file pins the projection lambdas the
 * dispatcher invokes around them — `subjectFrom`, `effectOnDeny`,
 * `effectOnError`, the reads' `audit.access_log` allow-effect, and
 * each verb's collapse policy — plus the surface/scope/category facts
 * the registry serves. Written per-capability (not table-driven): the
 * hooks are typed against each verb's input/output, and the
 * no-casting rule makes explicit typed calls the honest shape.
 */

import { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { describe, expect, it } from "vitest";

import { agentCreate } from "./create";
import { agentGet } from "./get";
import { agentList } from "./list";
import { agentRevoke } from "./revoke";
import { agentTokenList } from "./token_list";
import { agentTokenMint } from "./token_mint";
import { agentTokenRevoke } from "./token_revoke";
import { agentUpdate } from "./update";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const TOK = TokenId("018f0000-0000-7000-8000-0000000000c1");

const DENY = {
  kind: "missing_scope",
  required: [],
  principal_scopes: [],
} as const;
const INTERNAL = { kind: "internal", trace_id: "" } as const;

const AGENT_ROW = {
  agent_id: BOT,
  workspace_id: WORKSPACE_A,
  name: "bot",
  owner_user_id: ADMIN,
  created_by: ADMIN,
  created_at: 1,
  updated_at: 1,
  revoked_at: null,
};

describe("agent family — registry facts", () => {
  it("mutators ride agent:create / agent:revoke; reads ride workspace:read", () => {
    expect(agentCreate.requires).toEqual(["agent:create"]);
    expect(agentUpdate.requires).toEqual(["agent:create"]);
    expect(agentTokenMint.requires).toEqual(["agent:create"]);
    expect(agentRevoke.requires).toEqual(["agent:revoke"]);
    expect(agentTokenRevoke.requires).toEqual(["agent:revoke"]);
    expect(agentGet.requires).toEqual(["workspace:read"]);
    expect(agentList.requires).toEqual(["workspace:read"]);
    expect(agentTokenList.requires).toEqual(["workspace:read"]);
  });

  it("every verb is agent-allowed and on all four surfaces (the Agents screen has landed)", () => {
    // ADR 0044 Decision 7: the Agents-screen UI cells landed in lockstep
    // (`proves-capability-cell: agent.*` in packages/e2e + the parity
    // matrix's UI_PENDING ledger). All eight verbs now carry "ui" — the
    // earlier api/cli/mcp-only pin is retired.
    for (const cap of [
      agentCreate,
      agentGet,
      agentList,
      agentRevoke,
      agentTokenList,
      agentTokenMint,
      agentTokenRevoke,
      agentUpdate,
    ]) {
      expect(cap.agentAllowed).toEqual({});
      expect(cap.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    }
  });

  it("categories: five mutations, three reads", () => {
    expect(agentCreate.category).toBe("mutation");
    expect(agentUpdate.category).toBe("mutation");
    expect(agentRevoke.category).toBe("mutation");
    expect(agentTokenMint.category).toBe("mutation");
    expect(agentTokenRevoke.category).toBe("mutation");
    expect(agentGet.category).toBe("read");
    expect(agentList.category).toBe("read");
    expect(agentTokenList.category).toBe("read");
  });
});

describe("agent family — subject projections", () => {
  it("id-bearing verbs project their agent subject; token_revoke its token; list the workspace", () => {
    expect(agentCreate.audit.subjectFrom({ name: "x" })).toEqual({ kind: "agent" });
    expect(agentGet.audit.subjectFrom({ agent_id: BOT })).toEqual({ kind: "agent", id: BOT });
    expect(agentUpdate.audit.subjectFrom({ agent_id: BOT, name: "x" })).toEqual({
      kind: "agent",
      id: BOT,
    });
    expect(agentRevoke.audit.subjectFrom({ agent_id: BOT })).toEqual({ kind: "agent", id: BOT });
    expect(
      agentTokenMint.audit.subjectFrom({ agent_id: BOT, tier: "author", expires_at: null }),
    ).toEqual({ kind: "agent", id: BOT });
    expect(agentTokenRevoke.audit.subjectFrom({ token_id: TOK })).toEqual({
      kind: "token",
      id: TOK,
    });
    expect(agentTokenList.audit.subjectFrom({ agent_id: BOT })).toEqual({
      kind: "agent",
      id: BOT,
    });
    expect(agentList.audit.subjectFrom({})).toEqual({ kind: "workspace" });
  });
});

describe("agent family — deny + error projections", () => {
  it("deny effects carry the verb's own id and required scopes; reason code verbatim", () => {
    const denials = [
      {
        effect: agentCreate.audit.effectOnDeny({ name: "x" }, DENY),
        id: "agent.create",
        scopes: ["agent:create"],
      },
      {
        effect: agentGet.audit.effectOnDeny({ agent_id: BOT }, DENY),
        id: "agent.get",
        scopes: ["workspace:read"],
      },
      {
        effect: agentList.audit.effectOnDeny({}, DENY),
        id: "agent.list",
        scopes: ["workspace:read"],
      },
      {
        effect: agentUpdate.audit.effectOnDeny({ agent_id: BOT, name: "x" }, DENY),
        id: "agent.update",
        scopes: ["agent:create"],
      },
      {
        effect: agentRevoke.audit.effectOnDeny({ agent_id: BOT }, DENY),
        id: "agent.revoke",
        scopes: ["agent:revoke"],
      },
      {
        effect: agentTokenMint.audit.effectOnDeny(
          { agent_id: BOT, tier: "author", expires_at: null },
          DENY,
        ),
        id: "agent.token_mint",
        scopes: ["agent:create"],
      },
      {
        effect: agentTokenRevoke.audit.effectOnDeny({ token_id: TOK }, DENY),
        id: "agent.token_revoke",
        scopes: ["agent:revoke"],
      },
      {
        effect: agentTokenList.audit.effectOnDeny({ agent_id: BOT }, DENY),
        id: "agent.token_list",
        scopes: ["workspace:read"],
      },
    ];
    for (const { effect, id, scopes } of denials) {
      expect(effect.kind).toBe("deny");
      if (effect.kind === "deny") {
        expect(effect.capability).toBe(id);
        expect(effect.required_scopes).toEqual(scopes);
        expect(effect.reason_code).toBe("missing_scope");
      }
    }
  });

  it("error effects project through projectErrorAudit (internal → non-retriable)", () => {
    const errors = [
      agentCreate.audit.effectOnError({ name: "x" }, INTERNAL),
      agentGet.audit.effectOnError({ agent_id: BOT }, INTERNAL),
      agentList.audit.effectOnError({}, INTERNAL),
      agentUpdate.audit.effectOnError({ agent_id: BOT, name: "x" }, INTERNAL),
      agentRevoke.audit.effectOnError({ agent_id: BOT }, INTERNAL),
      agentTokenMint.audit.effectOnError(
        { agent_id: BOT, tier: "author", expires_at: null },
        INTERNAL,
      ),
      agentTokenRevoke.audit.effectOnError({ token_id: TOK }, INTERNAL),
      agentTokenList.audit.effectOnError({ agent_id: BOT }, INTERNAL),
    ];
    for (const effect of errors) {
      expect(effect.kind).toBe("error");
      if (effect.kind === "error") {
        expect(effect.error_code).toBe("internal");
        expect(effect.retriable).toBe(false);
      }
    }
  });
});

describe("agent family — allow effects (reads) + collapse policies", () => {
  it("the three reads emit audit.access_log on allow", () => {
    expect(agentGet.audit.effectOnAllow({ agent_id: BOT }, AGENT_ROW).kind).toBe(
      "audit.access_log",
    );
    expect(agentList.audit.effectOnAllow({}, { agents: [] }).kind).toBe("audit.access_log");
    expect(agentTokenList.audit.effectOnAllow({ agent_id: BOT }, { tokens: [] }).kind).toBe(
      "audit.access_log",
    );
  });

  it("reads collapse (get/token_list bucket by agent_id; list constant); mutators never collapse", () => {
    const tokenListPolicy = agentTokenList.audit.collapsePolicy;
    expect(tokenListPolicy.collapsible).toBe(true);
    if (tokenListPolicy.collapsible) {
      expect(tokenListPolicy.collapseKey({ agent_id: BOT })).toBe(`agent.token_list:${BOT}`);
      expect(tokenListPolicy.collapseKey(undefined)).toBe("agent.token_list:unvalidated");
    }
    const listPolicy = agentList.audit.collapsePolicy;
    expect(listPolicy.collapsible).toBe(true);
    if (listPolicy.collapsible) {
      expect(listPolicy.collapseKey({})).toBe("agent.list");
    }
    for (const cap of [agentCreate, agentUpdate, agentRevoke, agentTokenMint, agentTokenRevoke]) {
      expect(cap.audit.collapsePolicy.collapsible).toBe(false);
    }
  });
});
