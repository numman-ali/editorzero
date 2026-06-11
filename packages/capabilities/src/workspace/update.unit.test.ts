/**
 * `workspace.update` — capability-level integration test.
 *
 * Runs the handler against real in-memory SQLite; Layer-2 tenant
 * isolation is owned by `packages/db/src/tenant.unit.test.ts` (the
 * self-scope tests for `workspaces`). Here we confirm the capability
 * composes with that layer (a workspace-A ctx cannot update
 * workspace-B's row — the plugin-appended predicate makes the UPDATE
 * a no-op that returns zero rows, surfacing as 404).
 *
 * Validation rails (retention bounds, no-op rejection, strict keys)
 * are unit-tested via `safeParse` — the dispatcher's zod parse runs
 * ahead of the handler, so this mirrors the dispatcher's call path.
 */

import { createSqliteDriver, type SqliteDriver, WORKSPACES_DDL } from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { workspaceUpdate } from "./update";

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
    // `owner` carries `workspace:admin` per `dispatcher/gate.ts`. The
    // handler never checks scopes itself (dispatcher's Layer-1 job);
    // this is just a well-formed principal for the context.
    roles: ["owner"],
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
      throw new Error("transact not exercised by workspace.update (metadata-only)");
    },
    outbox: () => {
      /* workspace.update emits no outbox events in this slice */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1,
  };
}

async function seedWorkspaceA(overrides: { deleted_at?: number } = {}) {
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
      deleted_at: overrides.deleted_at ?? null,
      settings: '{"theme":"dark"}',
    })
    .execute();
}

async function seedWorkspaceB() {
  await driver
    .system()
    .insertInto("workspaces")
    .values({
      id: WORKSPACE_B,
      slug: "bob-def456",
      name: "bob's workspace",
      trash_retention_days: 30,
      diagnostic_salt: SALT,
      created_by: BOB,
      created_at: 200,
      deleted_at: null,
      settings: "{}",
    })
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("workspace.update", () => {
  it("updates name + trash_retention_days + settings together (happy path)", async () => {
    await seedWorkspaceA();
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceUpdate.handler(ctx, {
      name: "Renamed",
      trash_retention_days: 60,
      settings: { theme: "light", beta: true },
    });

    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      name: "Renamed",
      trash_retention_days: 60,
      settings: { theme: "light", beta: true },
    });

    // DB confirms the patch landed + slug was NOT touched.
    const row = await driver
      .system()
      .selectFrom("workspaces")
      .select(["slug", "name", "trash_retention_days", "settings", "created_at"])
      .where("id", "=", WORKSPACE_A)
      .executeTakeFirstOrThrow();
    expect(row.slug).toBe("alice-abc123");
    expect(row.name).toBe("Renamed");
    expect(row.trash_retention_days).toBe(60);
    expect(row.settings).toBe('{"theme":"light","beta":true}');
    expect(row.created_at).toBe(100);
  });

  it("partial update — only name, other fields retain prior values", async () => {
    await seedWorkspaceA();
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceUpdate.handler(ctx, { name: "Only Name" });

    expect(out.name).toBe("Only Name");
    expect(out.trash_retention_days).toBe(30);
    expect(out.settings).toEqual({ theme: "dark" });
  });

  it("trims whitespace on name (`.trim().min(1)`)", () => {
    const result = workspaceUpdate.input.safeParse({ name: "  padded  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("padded");
    }
  });

  it("rejects empty / whitespace-only name at the input schema", () => {
    const blank = workspaceUpdate.input.safeParse({ name: "" });
    expect(blank.success).toBe(false);
    const spaces = workspaceUpdate.input.safeParse({ name: "   " });
    expect(spaces.success).toBe(false);
  });

  it("rejects trash_retention_days below 7 and above 365 (ADR 0017 bounds)", () => {
    const low = workspaceUpdate.input.safeParse({ trash_retention_days: 6 });
    expect(low.success).toBe(false);
    const high = workspaceUpdate.input.safeParse({ trash_retention_days: 366 });
    expect(high.success).toBe(false);
  });

  it("rejects non-integer trash_retention_days", () => {
    const fractional = workspaceUpdate.input.safeParse({ trash_retention_days: 30.5 });
    expect(fractional.success).toBe(false);
  });

  it("rejects slug on input (slug is immutable per header doc)", () => {
    const result = workspaceUpdate.input.safeParse({ slug: "new-slug" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("rejects the empty / no-op input (at least one field required)", () => {
    const result = workspaceUpdate.input.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      // The refine produces `custom` rather than `unrecognized_keys`.
      const kinds = result.error.issues.map((i) => i.code);
      expect(kinds.includes("custom")).toBe(true);
    }
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot touch workspace-B", async () => {
    await seedWorkspaceB();
    // Workspace A has no row — so the UPDATE scoped to A returns zero
    // rows; the handler surfaces that as 404. Crucially, workspace B's
    // row is NOT touched (scoping plugin auto-appends `workspaces.id =
    // A`, so the UPDATE never references B).
    const ctxA = buildCtx(WORKSPACE_A);
    await expect(workspaceUpdate.handler(ctxA, { name: "Hijack" })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const bRow = await driver
      .system()
      .selectFrom("workspaces")
      .select(["name", "trash_retention_days"])
      .where("id", "=", WORKSPACE_B)
      .executeTakeFirstOrThrow();
    expect(bRow.name).toBe("bob's workspace");
    expect(bRow.trash_retention_days).toBe(30);
  });

  it("throws NotFoundError when the workspace is soft-deleted", async () => {
    await seedWorkspaceA({ deleted_at: 999 });
    const ctx = buildCtx(WORKSPACE_A);
    await expect(workspaceUpdate.handler(ctx, { name: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the workspace row is missing (bootstrap gap)", async () => {
    // Pre-prod edge: principal with a workspace_members row but no
    // workspaces anchor (e.g. the bootstrap hook partially failed).
    // 404 is the honest projection.
    const ctx = buildCtx(WORKSPACE_A);
    await expect(workspaceUpdate.handler(ctx, { name: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── Metadata-only enrolment ────────────────────────────────────────────

  it("is registered in METADATA_ONLY_CAPABILITIES", () => {
    expect(isMetadataOnlyCapability("workspace.update")).toBe(true);
  });

  // ── Registry metadata ──────────────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(workspaceUpdate.id).toBe("workspace.update");
    expect(workspaceUpdate.category).toBe("mutation");
    expect(workspaceUpdate.requires).toEqual(["workspace:admin"]);
    expect(workspaceUpdate.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(workspaceUpdate.agentAllowed).toEqual({});
  });

  // ── Audit projections ──────────────────────────────────────────────────

  it("projects a workspace subject (no id — audit row's workspace_id column carries it)", () => {
    const subject = workspaceUpdate.audit.subjectFrom({ name: "x" });
    expect(subject).toEqual({ kind: "workspace" });
  });

  it("audit patch omits fields the caller did not provide", () => {
    const effect = workspaceUpdate.audit.effectOnAllow(
      { name: "New" },
      {
        workspace_id: WORKSPACE_A,
        name: "New",
        trash_retention_days: 30,
        settings: { theme: "dark" },
      },
    );
    expect(effect.kind).toBe("workspace.update");
    if (effect.kind === "workspace.update") {
      expect(effect.workspace_id).toBe(WORKSPACE_A);
      // Only `name` in the patch — `trash_retention_days` and
      // `settings` are absent because the caller did not specify them.
      expect(effect.patch).toEqual({ name: "New" });
      expect(Object.keys(effect.patch)).not.toContain("trash_retention_days");
      expect(Object.keys(effect.patch)).not.toContain("settings");
    }
  });

  it("audit patch contains all three fields when the caller specified all three", () => {
    const effect = workspaceUpdate.audit.effectOnAllow(
      { name: "N", trash_retention_days: 60, settings: { theme: "light" } },
      {
        workspace_id: WORKSPACE_A,
        name: "N",
        trash_retention_days: 60,
        settings: { theme: "light" },
      },
    );
    if (effect.kind === "workspace.update") {
      expect(effect.patch).toEqual({
        name: "N",
        trash_retention_days: 60,
        settings: { theme: "light" },
      });
    }
  });

  it("emits a deny effect carrying the reason code + admin scope requirement", () => {
    const effect = workspaceUpdate.audit.effectOnDeny(
      { name: "x" },
      { kind: "missing_scope", required: ["workspace:admin"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("workspace.update");
      expect(effect.required_scopes).toEqual(["workspace:admin"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    const effect = workspaceUpdate.audit.effectOnError(
      { name: "x" },
      { kind: "not_found", subject_kind: "workspace", subject_id: WORKSPACE_A },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("workspace.update");
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("declares a non-collapsing audit policy (mutations are not collapsed)", () => {
    expect(workspaceUpdate.audit.collapsePolicy).toEqual({ collapsible: false });
  });
});
