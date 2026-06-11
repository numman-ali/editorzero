/**
 * `audit.list` — capability-level integration test.
 *
 * Runs the handler against real in-memory SQLite. Tenant isolation is
 * owned by `packages/db/src/tenant.unit.test.ts`; here we confirm the
 * capability composes with Layer-2 scoping (workspace-A ctx sees
 * only workspace-A's rows) and that the composite-cursor pagination,
 * filters, and effect JSON parsing all work against the real DDL.
 */

import { AUDIT_EVENTS_DDL, createSqliteDriver, type SqliteDriver } from "@editorzero/db";
import { UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import type { SubjectKind } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { auditList } from "./list";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const DOC_1 = "018f0000-0000-7000-8000-0000000000d1";
const DOC_2 = "018f0000-0000-7000-8000-0000000000d2";

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
      throw new Error("transact not exercised by audit.list");
    },
    outbox: () => {
      /* audit.list is a read — no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1,
  };
}

interface SeedRow {
  id: string;
  workspace_id?: WorkspaceId;
  capability_id?: string;
  category?: "mutation" | "read" | "auth" | "admin" | "system";
  outcome?: "allow" | "deny" | "error";
  subject_kind?: SubjectKind;
  subject_id?: string | null;
  deny_reason?: string | null;
  effect?: Record<string, unknown>;
  created_at?: number;
}

async function seed(rows: SeedRow[]): Promise<void> {
  const full = rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id ?? WORKSPACE_A,
    capability_id: r.capability_id ?? "doc.create",
    category: r.category ?? "mutation",
    principal_kind: "user" as const,
    principal_id: ALICE,
    acting_as_user_id: null,
    session_id: null,
    token_id: null,
    subject_kind: r.subject_kind ?? "doc",
    subject_id: r.subject_id ?? null,
    outcome: r.outcome ?? "allow",
    deny_reason: r.deny_reason ?? null,
    input_hash: "hash",
    effect: JSON.stringify(r.effect ?? { kind: "doc.create" }),
    duration_ms: 5,
    trace_id: null,
    created_at: r.created_at ?? 1000,
    collapsed_count: 1,
  }));
  await driver.system().insertInto("audit_events").values(full).execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("audit.list", () => {
  it("returns rows in (created_at DESC, id DESC) order with effect JSON parsed", async () => {
    await seed([
      { id: "0199aaaa-0000-7000-8000-000000000001", created_at: 100 },
      { id: "0199aaaa-0000-7000-8000-000000000002", created_at: 200 },
      { id: "0199aaaa-0000-7000-8000-000000000003", created_at: 300 },
    ]);
    const ctx = buildCtx(WORKSPACE_A);

    const out = await auditList.handler(ctx, { limit: 50 });

    expect(out.events.map((e) => e.id)).toEqual([
      "0199aaaa-0000-7000-8000-000000000003",
      "0199aaaa-0000-7000-8000-000000000002",
      "0199aaaa-0000-7000-8000-000000000001",
    ]);
    expect(out.events[0]?.effect).toEqual({ kind: "doc.create" });
    expect(out.next_cursor).toBe(null);
  });

  it("paginates via composite cursor — peek+trim + next_cursor", async () => {
    await seed([
      { id: "0199aaaa-0000-7000-8000-000000000001", created_at: 100 },
      { id: "0199aaaa-0000-7000-8000-000000000002", created_at: 200 },
      { id: "0199aaaa-0000-7000-8000-000000000003", created_at: 300 },
    ]);
    const ctx = buildCtx(WORKSPACE_A);

    // Page 1: limit=2. Peek returns 3; trim to 2; next_cursor set.
    const page1 = await auditList.handler(ctx, { limit: 2 });
    expect(page1.events.map((e) => e.id)).toEqual([
      "0199aaaa-0000-7000-8000-000000000003",
      "0199aaaa-0000-7000-8000-000000000002",
    ]);
    expect(page1.next_cursor).toEqual({
      before_created_at: 200,
      before_id: "0199aaaa-0000-7000-8000-000000000002",
    });

    // Page 2: use cursor. Only row 1 remains; next_cursor null.
    const page2 = await auditList.handler(ctx, {
      limit: 2,
      before_created_at: 200,
      before_id: "0199aaaa-0000-7000-8000-000000000002",
    });
    expect(page2.events.map((e) => e.id)).toEqual(["0199aaaa-0000-7000-8000-000000000001"]);
    expect(page2.next_cursor).toBe(null);
  });

  it("cursor tiebreak — equal created_at uses id DESC", async () => {
    await seed([
      { id: "0199aaaa-0000-7000-8000-000000000001", created_at: 100 },
      { id: "0199aaaa-0000-7000-8000-000000000002", created_at: 100 },
      { id: "0199aaaa-0000-7000-8000-000000000003", created_at: 100 },
    ]);
    const ctx = buildCtx(WORKSPACE_A);

    // Without cursor: DESC by id within the same timestamp.
    const page1 = await auditList.handler(ctx, { limit: 2 });
    expect(page1.events.map((e) => e.id)).toEqual([
      "0199aaaa-0000-7000-8000-000000000003",
      "0199aaaa-0000-7000-8000-000000000002",
    ]);
    expect(page1.next_cursor).toEqual({
      before_created_at: 100,
      before_id: "0199aaaa-0000-7000-8000-000000000002",
    });

    // Cursor page: `id < 002` at same timestamp → only 001 remains.
    const page2 = await auditList.handler(ctx, {
      limit: 2,
      before_created_at: 100,
      before_id: "0199aaaa-0000-7000-8000-000000000002",
    });
    expect(page2.events.map((e) => e.id)).toEqual(["0199aaaa-0000-7000-8000-000000000001"]);
    expect(page2.next_cursor).toBe(null);
  });

  it("filters by subject pair (kind + id)", async () => {
    await seed([
      {
        id: "0199aaaa-0000-7000-8000-000000000001",
        subject_kind: "doc",
        subject_id: DOC_1,
        created_at: 100,
      },
      {
        id: "0199aaaa-0000-7000-8000-000000000002",
        subject_kind: "doc",
        subject_id: DOC_2,
        created_at: 200,
      },
      {
        id: "0199aaaa-0000-7000-8000-000000000003",
        subject_kind: "workspace",
        subject_id: null,
        created_at: 300,
      },
    ]);
    const ctx = buildCtx(WORKSPACE_A);

    const out = await auditList.handler(ctx, {
      limit: 50,
      subject_kind: "doc",
      subject_id: DOC_1,
    });
    expect(out.events.map((e) => e.id)).toEqual(["0199aaaa-0000-7000-8000-000000000001"]);
  });

  it("filters by capability_id", async () => {
    await seed([
      { id: "0199aaaa-0000-7000-8000-000000000001", capability_id: "doc.create" },
      { id: "0199aaaa-0000-7000-8000-000000000002", capability_id: "doc.delete" },
      { id: "0199aaaa-0000-7000-8000-000000000003", capability_id: "doc.create" },
    ]);
    const ctx = buildCtx(WORKSPACE_A);

    const out = await auditList.handler(ctx, { limit: 50, capability_id: "doc.delete" });
    expect(out.events.map((e) => e.id)).toEqual(["0199aaaa-0000-7000-8000-000000000002"]);
  });

  it("filters by outcome", async () => {
    await seed([
      { id: "0199aaaa-0000-7000-8000-000000000001", outcome: "allow" },
      {
        id: "0199aaaa-0000-7000-8000-000000000002",
        outcome: "deny",
        deny_reason: "missing_scope",
      },
      { id: "0199aaaa-0000-7000-8000-000000000003", outcome: "error" },
    ]);
    const ctx = buildCtx(WORKSPACE_A);

    const out = await auditList.handler(ctx, { limit: 50, outcome: "deny" });
    expect(out.events.map((e) => e.id)).toEqual(["0199aaaa-0000-7000-8000-000000000002"]);
    expect(out.events[0]?.deny_reason).toBe("missing_scope");
  });

  it("filters by since/until time range (inclusive bounds)", async () => {
    await seed([
      { id: "0199aaaa-0000-7000-8000-000000000001", created_at: 100 },
      { id: "0199aaaa-0000-7000-8000-000000000002", created_at: 200 },
      { id: "0199aaaa-0000-7000-8000-000000000003", created_at: 300 },
    ]);
    const ctx = buildCtx(WORKSPACE_A);

    const out = await auditList.handler(ctx, { limit: 50, since: 200, until: 300 });
    expect(out.events.map((e) => e.id)).toEqual([
      "0199aaaa-0000-7000-8000-000000000003",
      "0199aaaa-0000-7000-8000-000000000002",
    ]);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot see workspace-B rows", async () => {
    await seed([
      { id: "0199aaaa-0000-7000-8000-000000000001", workspace_id: WORKSPACE_A },
      { id: "0199aaaa-0000-7000-8000-000000000002", workspace_id: WORKSPACE_B },
    ]);
    const ctx = buildCtx(WORKSPACE_A);

    const out = await auditList.handler(ctx, { limit: 50 });
    expect(out.events.map((e) => e.id)).toEqual(["0199aaaa-0000-7000-8000-000000000001"]);
  });

  it("returns empty events + null cursor when no rows match", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    const out = await auditList.handler(ctx, { limit: 50 });
    expect(out).toEqual({ events: [], next_cursor: null });
  });

  // ── Input schema ───────────────────────────────────────────────────────

  it("input — defaults limit to 50", () => {
    const result = auditList.input.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it("input — rejects limit out of [1, 200]", () => {
    expect(auditList.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(auditList.input.safeParse({ limit: 201 }).success).toBe(false);
    expect(auditList.input.safeParse({ limit: 1 }).success).toBe(true);
    expect(auditList.input.safeParse({ limit: 200 }).success).toBe(true);
  });

  it("input — rejects the cursor pair when only one is present", () => {
    expect(auditList.input.safeParse({ before_created_at: 100 }).success).toBe(false);
    expect(auditList.input.safeParse({ before_id: "x" }).success).toBe(false);
    expect(auditList.input.safeParse({ before_created_at: 100, before_id: "x" }).success).toBe(
      true,
    );
  });

  it("input — rejects subject_id without subject_kind", () => {
    const result = auditList.input.safeParse({ subject_id: DOC_1 });
    expect(result.success).toBe(false);
  });

  it("input — rejects since > until", () => {
    const result = auditList.input.safeParse({ since: 300, until: 200 });
    expect(result.success).toBe(false);
  });

  it("input — accepts since == until", () => {
    const result = auditList.input.safeParse({ since: 200, until: 200 });
    expect(result.success).toBe(true);
  });

  it("input — strict (rejects unknown keys)", () => {
    const result = auditList.input.safeParse({ bogus: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  // ── Registry metadata ──────────────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(auditList.id).toBe("audit.list");
    expect(auditList.category).toBe("read");
    expect(auditList.requires).toEqual(["workspace:admin"]);
    expect(auditList.surfaces).toEqual(["api", "cli", "mcp"]);
  });

  // ── Audit projections ──────────────────────────────────────────────────

  it("projects a workspace subject (tenant column carries the id)", () => {
    const subject = auditList.audit.subjectFrom({ limit: 50 });
    expect(subject).toEqual({ kind: "workspace" });
  });

  it("emits audit.access_log on allow", () => {
    const effect = auditList.audit.effectOnAllow({ limit: 50 }, { events: [], next_cursor: null });
    expect(effect.kind).toBe("audit.access_log");
  });

  it("emits a deny effect carrying the admin-scope requirement", () => {
    const effect = auditList.audit.effectOnDeny(
      { limit: 50 },
      { kind: "missing_scope", required: ["workspace:admin"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("audit.list");
      expect(effect.required_scopes).toEqual(["workspace:admin"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on error via projectErrorAudit", () => {
    const effect = auditList.audit.effectOnError(
      { limit: 50 },
      { kind: "not_found", subject_kind: "workspace", subject_id: WORKSPACE_A },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("audit.list");
      expect(effect.error_code).toBe("not_found");
    }
  });

  it("declares a constant collapse-key bucket at the SSOT window", () => {
    const policy = auditList.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(policy.collapseKey({ limit: 50 })).toBe("audit.list");
      expect(policy.window_ms).toBeGreaterThan(0);
    }
  });
});
