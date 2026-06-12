/**
 * `scopeOnlyGate` + `workspaceAwareGate` unit tests.
 *
 * The gate is used by the dispatcher's happy + deny paths, but two
 * branches are not reachable through the dispatcher after F86:
 *   - `cross_workspace` (dispatcher rejects the shape at entry with
 *     `TenantMismatchError` before the gate sees it — defense in
 *     depth keeps the gate check alive; this test is what proves
 *     the live check still works).
 *   - `human_only` (no dispatcher test currently constructs a
 *     `humanOnly: true` capability + agent principal).
 * Exercising the gate directly keeps both branches audited.
 *
 * `workspaceAwareGate` adds the H8 `acting_as` ∩ delegator
 * intersection (ADR 0040 Step 6). No agent can authenticate yet (the
 * `agents` table is a later slice), so the dispatcher cannot construct
 * a delegated principal end-to-end — these direct checks are the
 * proof the composition point behaves before the data exists, the
 * same machinery-before-data posture as the ceiling resolver.
 */

import { AgentId, CapabilityId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AccessPath, AgentPrincipal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { describe, expect, it } from "vitest";

import type { CapabilityGateMeta, LoadDelegatorRoles } from "./gate";
import { scopeOnlyGate, workspaceAwareGate } from "./gate";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

function humanMember(): UserPrincipal {
  return {
    kind: "user",
    id: ALICE,
    workspace_id: WORKSPACE_A,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function agent(overrides: Partial<AgentPrincipal> = {}): AgentPrincipal {
  return {
    kind: "agent",
    id: BOT,
    workspace_id: WORKSPACE_A,
    owner_user_id: ALICE,
    scopes: ["doc:read"],
    token_id: BOT_TOKEN,
    token_kind: "agent-auth",
    ...overrides,
  };
}

function cap(overrides: Partial<CapabilityGateMeta> = {}): CapabilityGateMeta {
  return {
    id: CapabilityId("doc.read"),
    requires: [],
    ...overrides,
  };
}

function accessIn(workspace_id: WorkspaceId): AccessPath {
  return { workspace_id };
}

describe("scopeOnlyGate", () => {
  const gate = scopeOnlyGate();

  it("allows a principal whose scopes cover the capability's requires", async () => {
    const result = await gate.check(
      humanMember(),
      cap({ requires: ["doc:read"] }),
      accessIn(WORKSPACE_A),
    );
    expect(result.outcome).toBe("allow");
  });

  it("denies with reason=cross_workspace when principal + access disagree", async () => {
    // F86 makes this path unreachable through the dispatcher, but the
    // gate check is still the Layer-1 backstop — verify the branch
    // directly here.
    const result = await gate.check(humanMember(), cap(), accessIn(WORKSPACE_B));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason.kind).toBe("cross_workspace");
    }
  });

  it("denies an agent against a humanOnly capability with reason=human_only", async () => {
    const result = await gate.check(
      agent(),
      cap({ humanOnly: true, requires: ["doc:read"] }),
      accessIn(WORKSPACE_A),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason.kind).toBe("human_only");
    }
  });

  it("allows a user against a humanOnly capability they have scopes for", async () => {
    const result = await gate.check(
      humanMember(),
      cap({ humanOnly: true, requires: ["doc:read"] }),
      accessIn(WORKSPACE_A),
    );
    expect(result.outcome).toBe("allow");
  });

  it("denies with reason=missing_scope listing the unsatisfied scopes", async () => {
    const result = await gate.check(
      humanMember(),
      cap({ requires: ["workspace:admin"] }),
      accessIn(WORKSPACE_A),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny" && result.reason.kind === "missing_scope") {
      expect(result.reason.required).toEqual(["workspace:admin"]);
    }
  });

  it("applies the agent's scope tier (`doc:read` is in `read-only` tier)", async () => {
    // An agent carrying the `read-only` scope tier should satisfy a
    // `requires: ["doc:read"]` capability without explicit scope copy.
    const bot = agent({ scopes: ["doc:read"] });
    const result = await gate.check(bot, cap({ requires: ["doc:read"] }), accessIn(WORKSPACE_A));
    expect(result.outcome).toBe("allow");
  });
});

describe("workspaceAwareGate — acting_as ∩ delegator (H8)", () => {
  /**
   * Role table the fake `loadDelegatorRoles` serves. Keyed by user id;
   * `null` = no active membership row (removed / never seeded).
   */
  function gateWith(
    rolesByUser: Record<string, readonly Role[] | null>,
    calls: Array<{ workspace_id: WorkspaceId; user_id: UserId }> = [],
  ) {
    const loadDelegatorRoles: LoadDelegatorRoles = async (workspace_id, user_id) => {
      calls.push({ workspace_id, user_id });
      return rolesByUser[user_id] ?? null;
    };
    return workspaceAwareGate({ loadDelegatorRoles });
  }

  it("behaves like scopeOnlyGate for user principals (no lookup issued)", async () => {
    const calls: Array<{ workspace_id: WorkspaceId; user_id: UserId }> = [];
    const gate = gateWith({}, calls);
    const result = await gate.check(
      humanMember(),
      cap({ requires: ["doc:read"] }),
      accessIn(WORKSPACE_A),
    );
    expect(result.outcome).toBe("allow");
    expect(calls).toHaveLength(0);
  });

  it("takes a NON-delegated agent's scopes verbatim (no lookup issued)", async () => {
    const calls: Array<{ workspace_id: WorkspaceId; user_id: UserId }> = [];
    const gate = gateWith({}, calls);
    const bot = agent({ token_kind: "api-key", scopes: ["doc:read", "doc:write"] });
    const result = await gate.check(bot, cap({ requires: ["doc:write"] }), accessIn(WORKSPACE_A));
    expect(result.outcome).toBe("allow");
    expect(calls).toHaveLength(0);
  });

  it("allows a delegated agent when BOTH the agent and the delegator hold the scope", async () => {
    const calls: Array<{ workspace_id: WorkspaceId; user_id: UserId }> = [];
    const gate = gateWith({ [ALICE]: ["member"] }, calls);
    const bot = agent({ acting_as: ALICE, scopes: ["doc:write"] });
    const result = await gate.check(bot, cap({ requires: ["doc:write"] }), accessIn(WORKSPACE_A));
    expect(result.outcome).toBe("allow");
    // The lookup hit the delegator's membership in the agent's workspace.
    expect(calls).toEqual([{ workspace_id: WORKSPACE_A, user_id: ALICE }]);
  });

  it("denies (missing_scope) when the agent claims a scope the DELEGATOR lacks — no escalation past the human", async () => {
    // Alice is a guest: no doc:write in her role-derived set. The agent
    // token CLAIMS doc:write; the intersection must strip it.
    const gate = gateWith({ [ALICE]: ["guest"] });
    const bot = agent({ acting_as: ALICE, scopes: ["doc:write", "doc:read"] });
    const result = await gate.check(bot, cap({ requires: ["doc:write"] }), accessIn(WORKSPACE_A));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny" && result.reason.kind === "missing_scope") {
      expect(result.reason.required).toEqual(["doc:write"]);
      // The reported effective set is the INTERSECTION, not the claim.
      expect(result.reason.principal_scopes).toEqual(["doc:read"]);
    } else {
      expect.unreachable("expected a missing_scope deny");
    }
  });

  it("denies (missing_scope) when the delegator has the scope but the agent token was not granted it", async () => {
    // Owner delegator, narrowly-scoped token: intersection cannot WIDEN
    // the agent past its own grant either — both directions narrow.
    const gate = gateWith({ [ALICE]: ["owner"] });
    const bot = agent({ acting_as: ALICE, scopes: ["doc:read"] });
    const result = await gate.check(bot, cap({ requires: ["doc:write"] }), accessIn(WORKSPACE_A));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") expect(result.reason.kind).toBe("missing_scope");
  });

  it("denies (delegator_not_member) when the acting_as user holds no active membership — revocation cuts the token", async () => {
    const gate = gateWith({ [ALICE]: null });
    const bot = agent({ acting_as: ALICE, scopes: ["doc:read"] });
    const result = await gate.check(bot, cap({ requires: ["doc:read"] }), accessIn(WORKSPACE_A));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason.kind).toBe("delegator_not_member");
    }
  });

  it("still denies cross_workspace FIRST for a delegated agent (no lookup issued)", async () => {
    const calls: Array<{ workspace_id: WorkspaceId; user_id: UserId }> = [];
    const gate = gateWith({ [ALICE]: ["owner"] }, calls);
    const bot = agent({ acting_as: ALICE, scopes: ["doc:read"] });
    const result = await gate.check(bot, cap({ requires: ["doc:read"] }), accessIn(WORKSPACE_B));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") expect(result.reason.kind).toBe("cross_workspace");
    expect(calls).toHaveLength(0);
  });

  it("still denies human_only for a delegated agent (delegation does not make it human; no lookup issued)", async () => {
    const calls: Array<{ workspace_id: WorkspaceId; user_id: UserId }> = [];
    const gate = gateWith({ [ALICE]: ["owner"] }, calls);
    const bot = agent({ acting_as: ALICE, scopes: ["doc:read"] });
    const result = await gate.check(
      bot,
      cap({ humanOnly: true, requires: ["doc:read"] }),
      accessIn(WORKSPACE_A),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") expect(result.reason.kind).toBe("human_only");
    expect(calls).toHaveLength(0);
  });
});
