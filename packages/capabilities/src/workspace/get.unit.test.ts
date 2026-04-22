/**
 * `workspace.get` — capability-level integration test.
 *
 * Exercises the handler against real in-memory SQLite. Layer-2 tenant
 * isolation for the self-scoped `workspaces` table is owned by
 * `packages/db/src/tenant.unit.test.ts`; here we confirm the capability
 * composes with that layer (workspace-A ctx reads only workspace-A's
 * row) and that the settings JSON column round-trips through
 * `JSON.parse`.
 */

import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { createSqliteDriver, type SqliteDriver, WORKSPACES_DDL } from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { workspaceGet } from "./get";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000b1");

const SALT = new Uint8Array(16);

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(WORKSPACES_DDL);
});

afterEach(async () => {
  await driver.close();
});

function userPrincipal(workspace_id: WorkspaceId = WORKSPACE_A): UserPrincipal {
  return {
    kind: "user",
    id: ALICE,
    workspace_id,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function buildCtx(workspace_id: WorkspaceId): CapabilityContext {
  return {
    principal: userPrincipal(workspace_id),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    transact: async () => {
      throw new Error("transact not exercised by workspace.get");
    },
    outbox: () => {
      /* workspace.get is a read — no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1,
  };
}

async function seedWorkspaces() {
  await driver
    .system()
    .insertInto("workspaces")
    .values([
      {
        id: WORKSPACE_A,
        slug: "alice-abc123",
        name: "alice's workspace",
        trash_retention_days: 30,
        diagnostic_salt: SALT,
        created_by: ALICE,
        created_at: 100,
        deleted_at: null,
        settings: '{"theme":"dark"}',
      },
      {
        id: WORKSPACE_B,
        slug: "bob-def456",
        name: "bob's workspace",
        trash_retention_days: 60,
        diagnostic_salt: SALT,
        created_by: BOB,
        created_at: 200,
        deleted_at: null,
        settings: "{}",
      },
    ])
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("workspace.get", () => {
  it("returns the caller's workspace row with settings parsed", async () => {
    await seedWorkspaces();
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceGet.handler(ctx, {});

    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      slug: "alice-abc123",
      name: "alice's workspace",
      trash_retention_days: 30,
      created_by: ALICE,
      created_at: 100,
      settings: { theme: "dark" },
    });
  });

  it("does not expose diagnostic_salt in the output", async () => {
    // Defense-in-depth — the salt is internal and the output schema
    // deliberately excludes it. Asserting at the handler level pins
    // the boundary even if a future refactor moved the SELECT to
    // `selectAll()`.
    await seedWorkspaces();
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceGet.handler(ctx, {});
    expect(out).not.toHaveProperty("diagnostic_salt");
  });

  it("composes with Layer-2 scoping: workspace-A ctx sees only workspace-A", async () => {
    await seedWorkspaces();
    const ctxA = buildCtx(WORKSPACE_A);
    const ctxB = buildCtx(WORKSPACE_B);

    const outA = await workspaceGet.handler(ctxA, {});
    const outB = await workspaceGet.handler(ctxB, {});

    expect(outA.workspace_id).toBe(WORKSPACE_A);
    expect(outA.created_by).toBe(ALICE);
    expect(outB.workspace_id).toBe(WORKSPACE_B);
    expect(outB.created_by).toBe(BOB);
  });

  it("throws NotFoundError when the workspace row is soft-deleted", async () => {
    await driver
      .system()
      .insertInto("workspaces")
      .values({
        id: WORKSPACE_A,
        slug: "alice-abc123",
        name: "alice's workspace",
        trash_retention_days: 30,
        diagnostic_salt: SALT,
        created_by: ALICE,
        created_at: 100,
        deleted_at: 999,
        settings: "{}",
      })
      .execute();

    const ctx = buildCtx(WORKSPACE_A);
    await expect(workspaceGet.handler(ctx, {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the workspace row is missing (bootstrap gap)", async () => {
    // Pre-prod edge: a principal has a valid session but the
    // workspaces row failed to land during signup. Post ADR 0024 the
    // resolver already refuses to mint a principal without a
    // workspace_members row; a workspace_members row without the
    // workspaces anchor is the remaining edge. Honest projection: 404.
    const ctx = buildCtx(WORKSPACE_A);
    await expect(workspaceGet.handler(ctx, {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects unknown input keys (strict)", () => {
    const result = workspaceGet.input.safeParse({ workspace_id: WORKSPACE_A });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("accepts the empty input shape", () => {
    const result = workspaceGet.input.safeParse({});
    expect(result.success).toBe(true);
  });

  it("declares the correct registry metadata", () => {
    expect(workspaceGet.id).toBe("workspace.get");
    expect(workspaceGet.category).toBe("read");
    expect(workspaceGet.requires).toEqual(["workspace:read"]);
    expect(workspaceGet.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
  });

  it("projects a workspace subject without id (tenant already on the audit row)", () => {
    const subject = workspaceGet.audit.subjectFrom({});
    expect(subject).toEqual({ kind: "workspace" });
  });

  it("emits audit.access_log on allow", () => {
    const effect = workspaceGet.audit.effectOnAllow(
      {},
      {
        workspace_id: WORKSPACE_A,
        slug: "alice-abc123",
        name: "alice's workspace",
        trash_retention_days: 30,
        created_by: ALICE,
        created_at: 100,
        settings: {},
      },
    );
    expect(effect.kind).toBe("audit.access_log");
  });

  it("emits a deny effect carrying the reason code", () => {
    const effect = workspaceGet.audit.effectOnDeny(
      {},
      { kind: "missing_scope", required: ["workspace:read"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("workspace.get");
      expect(effect.required_scopes).toEqual(["workspace:read"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    const effect = workspaceGet.audit.effectOnError(
      {},
      { kind: "not_found", subject_kind: "workspace", subject_id: WORKSPACE_A },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("workspace.get");
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("collapses globally (no input discriminator, window matches SSOT constant)", () => {
    const policy = workspaceGet.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(policy.collapseKey({})).toBe("workspace.get");
      expect(policy.window_ms).toBe(AUDIT_READ_COLLAPSE_WINDOW_MS);
    }
  });
});
