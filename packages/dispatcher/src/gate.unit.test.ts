/**
 * `scopeOnlyGate` unit tests.
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
 */

import { AgentId, CapabilityId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AccessPath, AgentPrincipal, UserPrincipal } from "@editorzero/principal";
import { describe, expect, it } from "vitest";

import type { CapabilityGateMeta } from "./gate";
import { scopeOnlyGate } from "./gate";

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
