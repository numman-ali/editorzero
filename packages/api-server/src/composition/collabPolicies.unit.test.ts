/**
 * The collab WS policy pair, tested at the composition seam (ADR 0030
 * attach standing + ADR 0043 Decision 3 write dispatch).
 *
 * The real WS wiring (Hocuspocus hooks, frames, closes) is covered by
 * the apps/server cohost integration suite; THESE tests pin the policy
 * semantics directly: the shared composed principal resolve (cookie +
 * bearer arms, the api-key-agents-only admit rail), the attach-time
 * authority terms (scope arithmetic + ACL ceiling + soft-delete deny),
 * the exact `doc.apply_update` dispatch shape, and the fail-closed
 * late-binding guard.
 */

import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  DOCS_DDL,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import type { DispatchInvocation } from "@editorzero/dispatcher";
import { AgentId, DocId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposedPrincipalResolver } from "../middleware/agent-bearer";
import { createCollabPolicies, isCollabAdmittedPrincipal } from "./collabPolicies";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-000000000002");
const AGENT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const TOKEN = TokenId("018f0000-0000-7000-8000-0000000000c1");
const DOC_LIVE = DocId("018f0000-0000-7000-8000-0000000000a1");
const DOC_TRASHED = DocId("018f0000-0000-7000-8000-0000000000a2");
const DOC_MISSING = DocId("018f0000-0000-7000-8000-0000000000a3");

const GOOD_COOKIE = "better-auth.session_token=good";
const GOOD_BEARER = "Bearer ez_agent_live";

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  driver.exec(DOCS_DDL);
});

afterEach(async () => {
  await driver.close();
});

function alice(roles: UserPrincipal["roles"] = ["member"]): UserPrincipal {
  return {
    kind: "user",
    id: ALICE,
    workspace_id: WORKSPACE_A,
    roles,
    session_id: null,
    token_id: null,
  };
}

/** An api-key agent owned by Alice; `scopes` default to `doc:read`. */
function apiKeyAgent(scopes: AgentPrincipal["scopes"] = ["doc:read"]): AgentPrincipal {
  return {
    kind: "agent",
    id: AGENT,
    workspace_id: WORKSPACE_A,
    owner_user_id: ALICE,
    scopes,
    token_id: TOKEN,
    token_kind: "api-key",
  };
}

/** A DELEGATED (agent-auth) agent — the WS surface must refuse it (H8 rail). */
function delegatedAgent(): AgentPrincipal {
  return {
    kind: "agent",
    id: AGENT,
    workspace_id: WORKSPACE_A,
    owner_user_id: ALICE,
    scopes: ["doc:read"],
    token_id: TOKEN,
    token_kind: "agent-auth",
    acting_as: ALICE,
  };
}

/**
 * Composed-resolver fake mirroring the real bearer-then-cookie core: an
 * explicit Bearer resolves on the GOOD bearer and NEVER falls back to
 * the cookie when wrong (the confused-deputy guard); otherwise the GOOD
 * cookie resolves. `principal` is what a matching credential yields.
 */
function composedResolverFor(principal: Principal): ComposedPrincipalResolver {
  return (headers) => {
    const authorization = headers.get("authorization");
    if (authorization !== null) {
      return Promise.resolve(authorization === GOOD_BEARER ? principal : null);
    }
    return Promise.resolve(headers.get("cookie") === GOOD_COOKIE ? principal : null);
  };
}

async function seedDoc(id: DocId, deleted_at: number | null = null): Promise<void> {
  await driver
    .scoped(WORKSPACE_A)
    .insertInto("docs")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      collection_id: null,
      title: "Collab policy doc",
      slug: "collab-policy-doc",
      order_key: id,
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
      created_by: ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at,
    })
    .execute();
}

interface PoliciesOptions {
  readonly principal?: Principal;
  readonly warn?: ReturnType<typeof vi.fn>;
}

function policies(options: PoliciesOptions = {}) {
  return createCollabPolicies({
    resolvePrincipal: composedResolverFor(options.principal ?? alice()),
    driver,
    logger: options.warn === undefined ? noopLogger : { ...noopLogger, warn: options.warn },
  });
}

describe("collabAuthorize (attach standing)", () => {
  it("admits a member with doc:read on a live in-workspace doc", async () => {
    await seedDoc(DOC_LIVE);
    await expect(
      policies().collabAuthorize({
        documentName: DOC_LIVE,
        requestHeaders: { cookie: GOOD_COOKIE },
      }),
    ).resolves.toBeUndefined();
  });

  it("denies when no session resolves — and logs the structured warn", async () => {
    await seedDoc(DOC_LIVE);
    const warn = vi.fn();
    await expect(
      policies({ warn }).collabAuthorize({
        documentName: DOC_LIVE,
        requestHeaders: { cookie: "better-auth.session_token=revoked" },
      }),
    ).rejects.toThrow(/no authenticated principal/);
    expect(warn).toHaveBeenCalledWith(
      "collab attach denied",
      expect.objectContaining({ event: "hocuspocus.authenticate", "collab.document": DOC_LIVE }),
    );
  });

  it("denies an absent cookie header outright", async () => {
    await expect(
      policies().collabAuthorize({ documentName: DOC_LIVE, requestHeaders: {} }),
    ).rejects.toThrow(/no authenticated principal/);
  });

  it("denies a principal whose roles grant no doc:read", async () => {
    await seedDoc(DOC_LIVE);
    await expect(
      policies({ principal: alice([]) }).collabAuthorize({
        documentName: DOC_LIVE,
        requestHeaders: { cookie: GOOD_COOKIE },
      }),
    ).rejects.toThrow(/lacks doc:read/);
  });

  it("denies a doc that does not exist in the principal's workspace", async () => {
    await expect(
      policies().collabAuthorize({
        documentName: DOC_MISSING,
        requestHeaders: { cookie: GOOD_COOKIE },
      }),
    ).rejects.toThrow(/not found in principal workspace/);
  });

  it("denies a soft-deleted doc (restore is the sanctioned route back)", async () => {
    await seedDoc(DOC_TRASHED, 999);
    await expect(
      policies().collabAuthorize({
        documentName: DOC_TRASHED,
        requestHeaders: { cookie: GOOD_COOKIE },
      }),
    ).rejects.toThrow(/not found in principal workspace/);
  });

  it("admits an api-key agent with doc:read on a live workspace-root doc (bearer lane)", async () => {
    await seedDoc(DOC_LIVE);
    await expect(
      policies({ principal: apiKeyAgent() }).collabAuthorize({
        documentName: DOC_LIVE,
        requestHeaders: { authorization: GOOD_BEARER },
      }),
    ).resolves.toBeUndefined();
  });

  it("denies an api-key agent whose token scopes lack doc:read (agent scope arithmetic)", async () => {
    await seedDoc(DOC_LIVE);
    await expect(
      policies({ principal: apiKeyAgent([]) }).collabAuthorize({
        documentName: DOC_LIVE,
        requestHeaders: { authorization: GOOD_BEARER },
      }),
    ).rejects.toThrow(/lacks doc:read/);
  });

  it("refuses a delegated agent token before any doc lookup (the H8 rail)", async () => {
    // No doc seeded — the rail throws before the ACL ceiling is consulted.
    await expect(
      policies({ principal: delegatedAgent() }).collabAuthorize({
        documentName: DOC_LIVE,
        requestHeaders: { authorization: GOOD_BEARER },
      }),
    ).rejects.toThrow(/only humans and api-key agents are admitted/);
  });
});

describe("collabApplyUpdate (per-frame write dispatch)", () => {
  it("fails closed before the dispatcher is wired", async () => {
    await expect(
      policies().collabApplyUpdate({
        documentName: DOC_LIVE,
        requestHeaders: { cookie: GOOD_COOKIE },
        update: "AAAA",
      }),
    ).rejects.toThrow(/dispatcher not wired/);
  });

  it("re-resolves the principal per frame — a dead session never reaches the dispatcher", async () => {
    const collab = policies();
    const dispatch = vi.fn(() => Promise.resolve({}));
    collab.wireDispatcher({ dispatch });
    await expect(
      collab.collabApplyUpdate({
        documentName: DOC_LIVE,
        requestHeaders: { cookie: "better-auth.session_token=revoked" },
        update: "AAAA",
      }),
    ).rejects.toThrow(/no authenticated principal/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches doc.apply_update with the wire input, fresh principal, and F86-aligned access", async () => {
    const principal = alice();
    const collab = policies({ principal });
    const calls: DispatchInvocation[] = [];
    collab.wireDispatcher({
      dispatch: (invocation) => {
        calls.push(invocation);
        return Promise.resolve({});
      },
    });
    await collab.collabApplyUpdate({
      documentName: DOC_LIVE,
      requestHeaders: { cookie: GOOD_COOKIE },
      update: "QUJDRA==",
    });
    expect(calls).toHaveLength(1);
    const invocation = calls[0];
    if (invocation === undefined) throw new Error("dispatch not called");
    expect(invocation.capability_id).toBe("doc.apply_update");
    expect(invocation.input).toEqual({ doc_id: DOC_LIVE, update: "QUJDRA==" });
    expect(invocation.principal).toBe(principal);
    expect(invocation.access).toEqual({ workspace_id: WORKSPACE_A });
    expect(invocation.trace_id).toBeNull();
  });

  it("propagates dispatcher refusals to the gate (the frame's refusal)", async () => {
    const refusal = new Error("validation_failed");
    const collab = policies();
    collab.wireDispatcher({ dispatch: () => Promise.reject(refusal) });
    await expect(
      collab.collabApplyUpdate({
        documentName: DOC_LIVE,
        requestHeaders: { cookie: GOOD_COOKIE },
        update: "AAAA",
      }),
    ).rejects.toBe(refusal);
  });

  it("re-resolves an api-key agent Bearer per frame and dispatches with the agent principal", async () => {
    const principal = apiKeyAgent();
    const collab = policies({ principal });
    const calls: DispatchInvocation[] = [];
    collab.wireDispatcher({
      dispatch: (invocation) => {
        calls.push(invocation);
        return Promise.resolve({});
      },
    });
    await collab.collabApplyUpdate({
      documentName: DOC_LIVE,
      requestHeaders: { authorization: GOOD_BEARER },
      update: "QUJDRA==",
    });
    const invocation = calls[0];
    if (invocation === undefined) throw new Error("dispatch not called");
    expect(invocation.principal).toBe(principal);
    expect(invocation.access).toEqual({ workspace_id: WORKSPACE_A });
  });
});

describe("isCollabAdmittedPrincipal (the shared WS admit rail)", () => {
  it("admits humans and api-key agents, refuses delegated (agent-auth) agents", () => {
    expect(isCollabAdmittedPrincipal(alice())).toBe(true);
    expect(isCollabAdmittedPrincipal(apiKeyAgent())).toBe(true);
    expect(isCollabAdmittedPrincipal(delegatedAgent())).toBe(false);
  });
});
