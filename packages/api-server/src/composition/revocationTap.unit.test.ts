/**
 * Revocation-tap pins (ADR 0043 Decision 5): the revoke-class map's
 * affected-subject derivation per capability, the drift guard on
 * output shapes, and the never-throws-into-dispatch containment.
 */

import {
  createSqliteDriver,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import type { DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollabSocketRegistry } from "./collabSockets";
import { createRevocationTap, withRevocationTap } from "./revocationTap";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-000000000002");
const GUEST_USER = UserId("018f0000-0000-7000-8000-000000000003");
const SECOND_GUEST = UserId("018f0000-0000-7000-8000-000000000004");
const SPACE = SpaceId("018f0000-0000-7000-8000-00000000c001");
const DOC = "018f0000-0000-7000-8000-0000000000d1";

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
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

function invocation(capability: string): DispatchInvocation {
  return {
    capability_id: CapabilityId(capability),
    input: {},
    principal: admin(),
    access: { workspace_id: WORKSPACE_A },
    trace_id: null,
  };
}

interface RegistryRecorder extends CollabSocketRegistry {
  readonly closedUsers: string[];
}

function recordingRegistry(): RegistryRecorder {
  const closedUsers: string[] = [];
  return {
    closedUsers,
    register: () => () => {
      /* unused in tap tests */
    },
    closeByUser(user_id) {
      closedUsers.push(user_id);
      return 1;
    },
    closeBySession: () => 0,
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

function tapWith(registry: CollabSocketRegistry, logger = noopLogger) {
  return createRevocationTap({ registry, driver, logger });
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

  it("closes nothing for an agent-kind grant subject (no agent sockets yet)", async () => {
    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(
      invocation("permission.revoke"),
      grantRowOutput("agent", "018f0000-0000-7000-8000-00000000f001"),
    );
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

  it("closes the doc's user-kind grant holders on doc.delete", async () => {
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("grants")
      .values([
        {
          id: GrantId("018f0000-0000-7000-8000-00000000e001"),
          workspace_id: WORKSPACE_A,
          resource_kind: "doc",
          resource_id: DOC,
          subject_kind: "user",
          subject_id: GUEST_USER,
          role: "view",
          is_guest: 1,
          created_by: ADMIN,
          created_at: 1,
        },
        {
          id: GrantId("018f0000-0000-7000-8000-00000000e002"),
          workspace_id: WORKSPACE_A,
          resource_kind: "doc",
          resource_id: DOC,
          subject_kind: "user",
          subject_id: SECOND_GUEST,
          role: "edit",
          is_guest: 1,
          created_by: ADMIN,
          created_at: 1,
        },
        {
          // Agent guest — must NOT close (no agent sockets today).
          id: GrantId("018f0000-0000-7000-8000-00000000e003"),
          workspace_id: WORKSPACE_A,
          resource_kind: "doc",
          resource_id: DOC,
          subject_kind: "agent",
          subject_id: "018f0000-0000-7000-8000-00000000f001",
          role: "view",
          is_guest: 1,
          created_by: ADMIN,
          created_at: 1,
        },
      ])
      .execute();

    const registry = recordingRegistry();
    await tapWith(registry).afterCommit(invocation("doc.delete"), {
      doc_id: DOC,
      deleted_at: 999,
    });
    expect(registry.closedUsers.toSorted()).toEqual([GUEST_USER, SECOND_GUEST].toSorted());
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
