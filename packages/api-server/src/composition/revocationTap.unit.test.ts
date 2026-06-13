/**
 * Revocation-tap pins (ADR 0043 Decision 5): the revoke-class map's
 * affected-subject derivation per capability, the drift guard on
 * output shapes, and the never-throws-into-dispatch containment.
 */

import {
  AGENTS_DDL,
  createSqliteDriver,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
  WORKSPACE_MEMBERS_DDL,
} from "@editorzero/db";
import type { DispatchInvocation } from "@editorzero/dispatcher";
import {
  AgentId,
  CapabilityId,
  GrantId,
  SpaceId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { noopLogger } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollabSocketRegistry } from "./collabSockets";
import { createRevocationTap, withRevocationTap } from "./revocationTap";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-000000000002");
const GUEST_USER = UserId("018f0000-0000-7000-8000-000000000003");
const SECOND_GUEST = UserId("018f0000-0000-7000-8000-000000000004");
const MEMBER_ONE = UserId("018f0000-0000-7000-8000-000000000005");
const MEMBER_TWO = UserId("018f0000-0000-7000-8000-000000000006");
const OWNER_USER = UserId("018f0000-0000-7000-8000-000000000007");
const SPACE = SpaceId("018f0000-0000-7000-8000-00000000c001");
const SPACE_CLOSED = SpaceId("018f0000-0000-7000-8000-00000000c002");
const SPACE_OPEN = SpaceId("018f0000-0000-7000-8000-00000000c003");
const DOC = "018f0000-0000-7000-8000-0000000000d1";
const AGENT_ONE = AgentId("018f0000-0000-7000-8000-0000000000a1");
const AGENT_TWO = AgentId("018f0000-0000-7000-8000-0000000000a2");
const TOKEN_ONE = TokenId("018f0000-0000-7000-8000-0000000000f1");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  driver.exec(WORKSPACE_MEMBERS_DDL);
  driver.exec(AGENTS_DDL);
});

afterEach(async () => {
  await driver.close();
});

function admin(): UserPrincipal {
  return {
    kind: "user",
    id: ADMIN,
    workspace_id: WORKSPACE_A,
    roles: ["admin"],
    session_id: null,
    token_id: null,
  };
}

function invocation(capability: string, input: unknown = {}): DispatchInvocation {
  return {
    capability_id: CapabilityId(capability),
    input,
    principal: admin(),
    access: { workspace_id: WORKSPACE_A },
    trace_id: null,
  };
}

interface RegistryRecorder extends CollabSocketRegistry {
  readonly closedUsers: string[];
  readonly closedAgents: string[];
  readonly closedTokens: string[];
}

function recordingRegistry(): RegistryRecorder {
  const closedUsers: string[] = [];
  const closedAgents: string[] = [];
  const closedTokens: string[] = [];
  return {
    closedUsers,
    closedAgents,
    closedTokens,
    register: () => () => {
      /* unused in tap tests */
    },
    closeByUser(user_id) {
      closedUsers.push(user_id);
      return 1;
    },
    closeBySession: () => 0,
    closeByAgent(agent_id) {
      closedAgents.push(agent_id);
      return 1;
    },
    closeByToken(token_id) {
      closedTokens.push(token_id);
      return 1;
    },
    size: () => 0,
  };
}

function grantRowOutput(subject_kind: "user" | "agent", subject_id: string): unknown {
  return {
    grant_id: GrantId("018f0000-0000-7000-8000-00000000e001"),
    workspace_id: WORKSPACE_A,
    resource_kind: "doc",
    resource_id: DOC,
    subject_kind,
    subject_id,
    role: "view",
    is_guest: 1,
    created_by: ADMIN,
    created_at: 1,
  };
}

function tapWith(
  registry: CollabSocketRegistry,
  logger = noopLogger,
  closeDocConnections?: (doc_id: string) => number,
) {
  return createRevocationTap({
    registry,
    driver,
    logger,
    ...(closeDocConnections !== undefined && { closeDocConnections }),
  });
}

function seedSpace(
  id: SpaceId,
  type: "open" | "closed" | "private",
  owner?: UserId,
): Promise<unknown> {
  return driver
    .scoped(WORKSPACE_A)
    .insertInto("spaces")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      // The schema CHECK pins (kind = 'personal') = (owner non-null).
      kind: owner === undefined ? "team" : "personal",
      type,
      owner_user_id: owner ?? null,
      name: `Space ${id.slice(-4)}`,
      slug: `space-${id.slice(-4)}`,
      baseline_access: "view",
      created_by: ADMIN,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .execute();
}

function seedSpaceMember(space_id: SpaceId, user_id: UserId): Promise<unknown> {
  return driver
    .scoped(WORKSPACE_A)
    .insertInto("space_members")
    .values({
      workspace_id: WORKSPACE_A,
      space_id,
      user_id,
      role: "view",
      created_at: 1,
      updated_at: 1,
    })
    .execute();
}

function seedWorkspaceMember(user_id: UserId): Promise<unknown> {
  return driver
    .scoped(WORKSPACE_A)
    .insertInto("workspace_members")
    .values({
      workspace_id: WORKSPACE_A,
      user_id,
      role: "member",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .execute();
}

function seedAgent(
  id: AgentId,
  owner_user_id: UserId,
  revoked_at: number | null = null,
): Promise<unknown> {
  return driver
    .scoped(WORKSPACE_A)
    .insertInto("agents")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      name: `agent-${id.slice(-4)}`,
      owner_user_id,
      created_by: owner_user_id,
      created_at: 1,
      updated_at: 1,
      revoked_at,
    })
    .execute();
}

/** A move output, optionally carrying the crossing receipt. */
function moveOutput(transition?: {
  before_space_id: SpaceId | null;
  after_space_id: SpaceId | null;
  dropped_grants?: unknown[];
}): unknown {
  return {
    doc_id: DOC,
    new_collection_id: null,
    ...(transition !== undefined && {
      acl_transition: {
        policy: "adopt_baseline",
        before_space_id: transition.before_space_id,
        after_space_id: transition.after_space_id,
        dropped_grants: transition.dropped_grants ?? [],
      },
    }),
  };
}

describe("createRevocationTap — affected-subject derivation", () => {
  it("ignores non-revoke-class capabilities", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(invocation("doc.apply_update"), { doc_id: DOC });
    expect(registry.closedUsers).toEqual([]);
  });

  it("closes the revoked grant's user subject on permission.revoke", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("permission.revoke"),
      grantRowOutput("user", GUEST_USER),
    );
    expect(registry.closedUsers).toEqual([GUEST_USER]);
  });

  it("closes the agent on an agent-kind grant subject (ADR 0044 Decision 5 — skip dropped)", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("permission.revoke"),
      grantRowOutput("agent", AGENT_ONE),
    );
    expect(registry.closedAgents).toEqual([AGENT_ONE]);
    expect(registry.closedUsers).toEqual([]);
  });

  it("closes the removed guest on doc.remove_guest", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("doc.remove_guest"),
      grantRowOutput("user", GUEST_USER),
    );
    expect(registry.closedUsers).toEqual([GUEST_USER]);
  });

  it("closes the affected member on membership removes AND role updates", async () => {
    for (const capability of [
      "space.member_remove",
      "space.member_update_role",
      "workspace.member_remove",
      "workspace.member_update_role",
    ]) {
      const registry = recordingRegistry();
      await tapWith(registry).afterCommit(invocation(capability), {
        workspace_id: WORKSPACE_A,
        user_id: GUEST_USER,
        role: "view",
      });
      expect(registry.closedUsers).toEqual([GUEST_USER]);
    }
  });

  it("closes the whole agent on agent.revoke", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(invocation("agent.revoke"), {
      agent_id: AGENT_ONE,
      revoked_at: 999,
    });
    expect(registry.closedAgents).toEqual([AGENT_ONE]);
    expect(registry.closedUsers).toEqual([]);
    expect(registry.closedTokens).toEqual([]);
  });

  it("closes a single token on agent.token_revoke", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(invocation("agent.token_revoke"), {
      token_id: TOKEN_ONE,
      revoked_at: 999,
    });
    expect(registry.closedTokens).toEqual([TOKEN_ONE]);
    expect(registry.closedAgents).toEqual([]);
    expect(registry.closedUsers).toEqual([]);
  });

  it("workspace.member_remove ALSO closes the removed owner's live agents (ADR 0044 Decision 2)", async () => {
    // OWNER_USER owns two live agents and one already-revoked agent;
    // GUEST_USER owns an agent that must NOT close (different owner).
    await seedAgent(AGENT_ONE, OWNER_USER);
    await seedAgent(AGENT_TWO, OWNER_USER);
    await seedAgent(AgentId("018f0000-0000-7000-8000-0000000000a9"), OWNER_USER, /* revoked */ 5);
    await seedAgent(AgentId("018f0000-0000-7000-8000-0000000000b1"), GUEST_USER);

    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(invocation("workspace.member_remove"), {
      workspace_id: WORKSPACE_A,
      user_id: OWNER_USER,
      role: "member",
    });

    expect(registry.closedUsers).toEqual([OWNER_USER]);
    // Both live owned agents close; the revoked one (no sockets) and the
    // other owner's agent are untouched. Order-independent compare.
    expect([...registry.closedAgents].sort()).toEqual([AGENT_ONE, AGENT_TWO].sort());
  });

  it("closes the trashed doc's ROOM on doc.delete — per-document close, sockets untouched", async () => {
    const registry = recordingRegistry();
    const roomCloses: string[] = [];
    await tapWith(registry, noopLogger, (docId) => {
      roomCloses.push(docId);
      return 3;
    }).afterCommit(invocation("doc.delete"), { doc_id: DOC, deleted_at: 999 });
    expect(roomCloses).toEqual([DOC]);
    // No user-level closes: grant standing survives soft-delete
    // (restore revives it) — the ROOM dying is the whole posture.
    expect(registry.closedUsers).toEqual([]);
  });

  it("contains an unwired doc-close arm as a logged tap failure (never a crash)", async () => {
    const registry = recordingRegistry();
    const error = vi.fn();
    await tapWith(registry, { ...noopLogger, error }).afterCommit(invocation("doc.delete"), {
      doc_id: DOC,
      deleted_at: 999,
    });
    expect(registry.closedUsers).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("revocation tap failed"),
      expect.objectContaining({ "collab.reason": expect.stringContaining("unwired") }),
    );
  });

  it("closes the space's members on space.archive", async () => {
    // space_members carries a composite FK to spaces(id, workspace_id).
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("spaces")
      .values({
        id: SPACE,
        workspace_id: WORKSPACE_A,
        kind: "team",
        type: "closed",
        owner_user_id: null,
        name: "Archived space",
        slug: "archived-space",
        baseline_access: "view",
        created_by: ADMIN,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("space_members")
      .values([
        {
          workspace_id: WORKSPACE_A,
          space_id: SPACE,
          user_id: GUEST_USER,
          role: "edit",
          created_at: 1,
          updated_at: 1,
        },
        {
          workspace_id: WORKSPACE_A,
          space_id: SPACE,
          user_id: SECOND_GUEST,
          role: "view",
          created_at: 1,
          updated_at: 1,
        },
      ])
      .execute();

    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(invocation("space.archive"), {
      space_id: SPACE,
      archived_at: 999,
    });
    expect(registry.closedUsers.toSorted()).toEqual([GUEST_USER, SECOND_GUEST].toSorted());
  });

  it("ignores a same-bucket move (no crossing receipt, no reader change)", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(invocation("doc.move"), moveOutput());
    expect(registry.closedUsers).toEqual([]);
  });

  it("closes dropped-grant users AND before-space members on a crossing into a closed space", async () => {
    await seedSpace(SPACE, "closed");
    await seedSpace(SPACE_CLOSED, "closed");
    await seedSpaceMember(SPACE, MEMBER_ONE);
    await seedSpaceMember(SPACE, MEMBER_TWO);

    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("doc.move"),
      moveOutput({
        before_space_id: SPACE,
        after_space_id: SPACE_CLOSED,
        dropped_grants: [
          grantRowOutput("user", GUEST_USER),
          // Agent guest — no agent sockets exist; must not close.
          grantRowOutput("agent", "018f0000-0000-7000-8000-00000000f001"),
        ],
      }),
    );
    expect(registry.closedUsers.toSorted()).toEqual(
      [GUEST_USER, MEMBER_ONE, MEMBER_TWO].toSorted(),
    );
  });

  it("keeps placement readers attached when the move lands in an OPEN space — only dropped grants close", async () => {
    await seedSpace(SPACE, "closed");
    await seedSpace(SPACE_OPEN, "open");
    await seedSpaceMember(SPACE, MEMBER_ONE);

    // collection.move shares the extractor — pinned via this lane.
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("collection.move"),
      moveOutput({
        before_space_id: SPACE,
        after_space_id: SPACE_OPEN,
        dropped_grants: [grantRowOutput("user", GUEST_USER)],
      }),
    );
    expect(registry.closedUsers).toEqual([GUEST_USER]);
  });

  it("closes the workspace's members on a root → closed-space crossing", async () => {
    await seedSpace(SPACE_CLOSED, "closed");
    await seedWorkspaceMember(MEMBER_ONE);
    await seedWorkspaceMember(MEMBER_TWO);

    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("doc.move"),
      moveOutput({ before_space_id: null, after_space_id: SPACE_CLOSED }),
    );
    expect(registry.closedUsers.toSorted()).toEqual([MEMBER_ONE, MEMBER_TWO].toSorted());
  });

  it("closes ALL live members when the BEFORE bucket was an OPEN space — org baseline, not roster (Codex pin)", async () => {
    // The lift-gate round's concrete miss: a member reading an open
    // space with NO roster row must close when the doc crosses into a
    // closed space — the roster alone undercounts open-space readers.
    await seedSpace(SPACE, "open");
    await seedSpace(SPACE_CLOSED, "closed");
    await seedWorkspaceMember(MEMBER_ONE);
    await seedWorkspaceMember(MEMBER_TWO); // deliberately NOT a space_members row

    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("doc.move"),
      moveOutput({ before_space_id: SPACE, after_space_id: SPACE_CLOSED }),
    );
    expect(registry.closedUsers.toSorted()).toEqual([MEMBER_ONE, MEMBER_TWO].toSorted());
  });

  it("walks the full reader ladder for a restrictive BEFORE bucket: owner + roster + user-kind space grants", async () => {
    await seedSpace(SPACE, "private", OWNER_USER); // personal — owner reads without a roster row
    await seedSpace(SPACE_CLOSED, "closed");
    await seedSpaceMember(SPACE, MEMBER_ONE);
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-00000000e009"),
        workspace_id: WORKSPACE_A,
        resource_kind: "space",
        resource_id: SPACE,
        subject_kind: "user",
        subject_id: SECOND_GUEST,
        role: "view",
        is_guest: 1,
        created_by: ADMIN,
        created_at: 1,
      })
      .execute();

    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("collection.move"),
      moveOutput({ before_space_id: SPACE, after_space_id: SPACE_CLOSED }),
    );
    expect(registry.closedUsers.toSorted()).toEqual(
      [OWNER_USER, MEMBER_ONE, SECOND_GUEST].toSorted(),
    );
  });

  it("ignores a space.update that does not set space_type (a rename narrows nobody)", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("space.update", { space_id: SPACE, name: "Renamed" }),
      { space_id: SPACE },
    );
    expect(registry.closedUsers).toEqual([]);
  });

  it("closes org-baseline readers (members minus roster) when space.update sets a restrictive type", async () => {
    await seedSpace(SPACE, "open");
    await seedWorkspaceMember(MEMBER_ONE);
    await seedWorkspaceMember(MEMBER_TWO);
    await seedSpaceMember(SPACE, MEMBER_ONE); // roster retains read standing

    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("space.update", { space_id: SPACE, space_type: "closed" }),
      { space_id: SPACE },
    );
    expect(registry.closedUsers).toEqual([MEMBER_TWO]);
  });

  it("ignores space.update setting type to open (widening)", async () => {
    await seedWorkspaceMember(MEMBER_ONE);
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("space.update", { space_id: SPACE, space_type: "open" }),
      { space_id: SPACE },
    );
    expect(registry.closedUsers).toEqual([]);
  });

  it("logs loud and closes nothing when a revoke-class output drifts (drift guard)", async () => {
    const registry = recordingRegistry();
    const error = vi.fn();
    await tapWith(registry, { ...noopLogger, error }).afterCommit(invocation("permission.revoke"), {
      not: "a grant row",
    });
    expect(registry.closedUsers).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("revocation tap failed"),
      expect.objectContaining({ event: "session.revoke_close" }),
    );
  });
});

describe("withRevocationTap", () => {
  it("returns the dispatch output and taps after success", async () => {
    const registry = recordingRegistry();
    const tap = tapWith(registry);
    const wrapped = withRevocationTap(
      {
        dispatch: () => Promise.resolve(grantRowOutput("user", GUEST_USER)),
        // biome-ignore lint/suspicious/noExplicitAny: structural deps stub — the tap never reads deps.
        deps: {} as any,
      },
      tap,
    );
    const output = await wrapped.dispatch(invocation("permission.revoke"));
    expect(output).toMatchObject({ subject_id: GUEST_USER });
    expect(registry.closedUsers).toEqual([GUEST_USER]);
  });

  it("passes refusals through untouched — nothing committed, nothing closed", async () => {
    const registry = recordingRegistry();
    const refusal = new Error("permission_denied");
    const wrapped = withRevocationTap(
      {
        dispatch: () => Promise.reject(refusal),
        // biome-ignore lint/suspicious/noExplicitAny: structural deps stub — the tap never reads deps.
        deps: {} as any,
      },
      tapWith(registry),
    );
    await expect(wrapped.dispatch(invocation("permission.revoke"))).rejects.toBe(refusal);
    expect(registry.closedUsers).toEqual([]);
  });

  it("never lets a tap failure reject a committed dispatch", async () => {
    const registry: CollabSocketRegistry = {
      register: () => () => {
        /* unused */
      },
      closeByUser: () => {
        throw new Error("registry exploded");
      },
      closeBySession: () => 0,
      closeByAgent: () => 0,
      closeByToken: () => 0,
      size: () => 0,
    };
    const error = vi.fn();
    const wrapped = withRevocationTap(
      {
        dispatch: () => Promise.resolve(grantRowOutput("user", GUEST_USER)),
        // biome-ignore lint/suspicious/noExplicitAny: structural deps stub — the tap never reads deps.
        deps: {} as any,
      },
      createRevocationTap({ registry, driver, logger: { ...noopLogger, error } }),
    );
    await expect(wrapped.dispatch(invocation("permission.revoke"))).resolves.toMatchObject({
      subject_kind: "user",
    });
    expect(error).toHaveBeenCalled();
  });
});
