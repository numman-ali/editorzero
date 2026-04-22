/**
 * `audit.get` — capability-level integration test.
 *
 * Runs the handler against real in-memory SQLite. Tenant isolation is
 * owned by `packages/db/src/tenant.unit.test.ts`; here we confirm the
 * capability composes with Layer-2 scoping (workspace-A ctx cannot
 * fetch workspace-B audit rows — the SELECT is tenant-filtered, and
 * a cross-workspace lookup surfaces as 404).
 */

import { AUDIT_EVENTS_DDL, createSqliteDriver, type SqliteDriver } from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { auditGet } from "./get";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const ROW_ID_A = "0199aaaa-0000-7000-8000-0000000000a1";
const ROW_ID_B = "0199aaaa-0000-7000-8000-0000000000b1";

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(AUDIT_EVENTS_DDL);
});

afterEach(async () => {
  await driver.close();
});

function userPrincipal(workspace_id: WorkspaceId = WORKSPACE_A): UserPrincipal {
  return {
    kind: "user",
    id: ALICE,
    workspace_id,
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
      throw new Error("transact not exercised by audit.get");
    },
    outbox: () => {
      /* audit.get is a read — no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1,
  };
}

async function seedRow(params: {
  id: string;
  workspace_id: WorkspaceId;
  effect?: Record<string, unknown>;
}) {
  await driver
    .system()
    .insertInto("audit_events")
    .values({
      id: params.id,
      workspace_id: params.workspace_id,
      capability_id: "doc.create",
      category: "mutation",
      principal_kind: "user",
      principal_id: ALICE,
      acting_as_user_id: null,
      session_id: null,
      token_id: null,
      subject_kind: "doc",
      subject_id: null,
      outcome: "allow",
      deny_reason: null,
      input_hash: "hash",
      effect: JSON.stringify(params.effect ?? { kind: "doc.create", doc_id: "d1" }),
      duration_ms: 5,
      trace_id: null,
      created_at: 1000,
      collapsed_count: 1,
    })
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("audit.get", () => {
  it("returns the row with effect JSON parsed", async () => {
    await seedRow({
      id: ROW_ID_A,
      workspace_id: WORKSPACE_A,
      effect: { kind: "doc.create", doc_id: "d1", foo: "bar" },
    });
    const ctx = buildCtx(WORKSPACE_A);

    const out = await auditGet.handler(ctx, { audit_id: ROW_ID_A });

    expect(out.id).toBe(ROW_ID_A);
    expect(out.workspace_id).toBe(WORKSPACE_A);
    expect(out.capability_id).toBe("doc.create");
    expect(out.effect).toEqual({ kind: "doc.create", doc_id: "d1", foo: "bar" });
  });

  it("throws NotFoundError when the id does not exist", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    await expect(auditGet.handler(ctx, { audit_id: ROW_ID_A })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot fetch workspace-B rows", async () => {
    await seedRow({ id: ROW_ID_B, workspace_id: WORKSPACE_B });
    const ctxA = buildCtx(WORKSPACE_A);

    // The row exists, but the scoped SELECT appends `workspace_id =
    // A`, so it returns zero rows and the handler 404s. Crucially,
    // workspace B's row is NOT touched.
    await expect(auditGet.handler(ctxA, { audit_id: ROW_ID_B })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  // ── Input schema ───────────────────────────────────────────────────────

  it("input — requires a UUIDv7 audit_id", () => {
    const invalid = auditGet.input.safeParse({ audit_id: "not-a-uuid" });
    expect(invalid.success).toBe(false);

    const v4 = auditGet.input.safeParse({ audit_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479" });
    expect(v4.success).toBe(false);

    const v7 = auditGet.input.safeParse({ audit_id: ROW_ID_A });
    expect(v7.success).toBe(true);
  });

  it("input — strict (rejects unknown keys)", () => {
    const result = auditGet.input.safeParse({ audit_id: ROW_ID_A, bogus: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  // ── Registry metadata ──────────────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(auditGet.id).toBe("audit.get");
    expect(auditGet.category).toBe("read");
    expect(auditGet.requires).toEqual(["workspace:admin"]);
    expect(auditGet.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
  });

  // ── Audit projections ──────────────────────────────────────────────────

  it("projects a workspace subject (tenant column carries the id)", () => {
    const subject = auditGet.audit.subjectFrom({ audit_id: ROW_ID_A });
    expect(subject).toEqual({ kind: "workspace" });
  });

  it("emits audit.access_log on allow", () => {
    const effect = auditGet.audit.effectOnAllow(
      { audit_id: ROW_ID_A },
      {
        id: ROW_ID_A,
        workspace_id: WORKSPACE_A,
        capability_id: "doc.create",
        category: "mutation",
        principal_kind: "user",
        principal_id: ALICE,
        acting_as_user_id: null,
        session_id: null,
        token_id: null,
        subject_kind: "doc",
        subject_id: null,
        outcome: "allow",
        deny_reason: null,
        input_hash: "hash",
        effect: { kind: "doc.create" },
        duration_ms: 5,
        trace_id: null,
        created_at: 1000,
        collapsed_count: 1,
      },
    );
    expect(effect.kind).toBe("audit.access_log");
  });

  it("emits a deny effect carrying the admin-scope requirement", () => {
    const effect = auditGet.audit.effectOnDeny(
      { audit_id: ROW_ID_A },
      { kind: "missing_scope", required: ["workspace:admin"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("audit.get");
      expect(effect.required_scopes).toEqual(["workspace:admin"]);
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    const effect = auditGet.audit.effectOnError(
      { audit_id: ROW_ID_A },
      { kind: "not_found", subject_kind: "workspace", subject_id: WORKSPACE_A },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("audit.get");
      expect(effect.error_code).toBe("not_found");
    }
  });

  it("uses a per-id collapse bucket (two different rows = two audit rows)", () => {
    const policy = auditGet.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(policy.collapseKey({ audit_id: ROW_ID_A })).toBe(`audit.get:${ROW_ID_A}`);
      expect(policy.collapseKey({ audit_id: ROW_ID_B })).toBe(`audit.get:${ROW_ID_B}`);
      expect(policy.window_ms).toBeGreaterThan(0);
    }
  });
});
