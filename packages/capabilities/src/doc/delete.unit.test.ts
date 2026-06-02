/**
 * `doc.delete` — capability-level integration test. Mirror of
 * `doc.publish`'s test posture: exercises the handler against real
 * in-memory SQLite; no sync service (metadata-only mutation, no
 * `ctx.transact`). Layer-2 tenant isolation is owned by
 * `packages/db/src/tenant.unit.test.ts`; here we confirm the
 * capability composes with that layer.
 */

import { createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { type CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docDelete } from "./delete";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2_DELETED = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d3");
const DOC_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(DOCS_DDL);
});

afterEach(async () => {
  await driver.close();
});

function userPrincipal(): UserPrincipal {
  return {
    kind: "user",
    id: ALICE,
    workspace_id: WORKSPACE_A,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function buildCtx(workspace_id: WorkspaceId, now: () => number = () => 1000): CapabilityContext {
  return {
    principal: userPrincipal(),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    // Metadata-only capability; `ctx.transact` must not be called. Stub
    // throws so a regression (handler quietly opens a Y.Doc tx) shows
    // up as a test failure rather than silent noop.
    transact: () => {
      throw new Error("doc.delete: handler must not call ctx.transact (metadata-only)");
    },
    outbox: () => {
      /* no outbox emissions in v1; `ctx.outbox` un-stub is Phase 4 */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now,
  };
}

async function seedDocRow(params: {
  id: DocId;
  workspace_id: WorkspaceId;
  title: string;
  visibility?: "workspace" | "public" | "private";
  visibility_version?: number;
  collection_id?: CollectionId | null;
  deleted_at?: number | null;
}) {
  const scoped = driver.scoped(params.workspace_id);
  await scoped
    .insertInto("docs")
    .values({
      id: params.id,
      workspace_id: params.workspace_id,
      collection_id: params.collection_id ?? null,
      title: params.title,
      slug: params.title.toLowerCase(),
      order_key: params.id,
      visibility: params.visibility ?? "workspace",
      visibility_version: params.visibility_version ?? 0,
      created_by: ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at: params.deleted_at ?? null,
    })
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.delete", () => {
  it("flips deleted_at from NULL to now, bumps visibility_version, returns the post-state", async () => {
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Draft",
      visibility_version: 3,
    });

    const ctx = buildCtx(WORKSPACE_A, () => 2_000_000);
    const out = await docDelete.handler(ctx, { doc_id: DOC_A1 });

    expect(out).toEqual({
      doc_id: DOC_A1,
      deleted_at: 2_000_000,
      visibility_version: 4,
    });

    // Verify the docs row was actually updated. Read via the tenant-
    // scoped handle; the WorkspaceScopingPlugin injects workspace_id
    // but not deleted_at, so we can still inspect trashed rows here.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version", "updated_at"])
      .where("id", "=", DOC_A1)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBe(2_000_000);
    expect(row.visibility_version).toBe(4);
    expect(row.updated_at).toBe(2_000_000);
  });

  it("bumps visibility_version on every successful call (public-route cache invalidation — §5.4)", async () => {
    // The public-route cache keys on `visibility_version`; a delete
    // of a published doc must flip "renders" → "404", which means the
    // version has to move. Sibling assertion to publish/unpublish's
    // always-bump invariant.
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Live doc",
      visibility: "public",
      visibility_version: 11,
    });

    const ctx = buildCtx(WORKSPACE_A, () => 5_000_000);
    const out = await docDelete.handler(ctx, { doc_id: DOC_A1 });
    expect(out.visibility_version).toBe(12);
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    await expect(docDelete.handler(ctx, { doc_id: DOC_MISSING })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("treats already-soft-deleted docs as 404 (honest projection; preserves recovery-window anchor)", async () => {
    // Idempotent state != idempotent operation. A re-delete call
    // returning 200 would imply slide of `deleted_at` to `now`, which
    // slides the 30-day recovery window — a silent durability
    // regression. Honest 404 + the row staying untouched is the
    // contract (doc-block rationale).
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Already trashed",
      deleted_at: 999,
      visibility_version: 5,
    });
    const ctx = buildCtx(WORKSPACE_A, () => 5_000_000);
    await expect(docDelete.handler(ctx, { doc_id: DOC_A2_DELETED })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Row must survive untouched — recovery anchor preserved, version
    // not bumped (no state change).
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version"])
      .where("id", "=", DOC_A2_DELETED)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBe(999);
    expect(row.visibility_version).toBe(5);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot delete workspace-B doc", async () => {
    await seedDocRow({ id: DOC_B1, workspace_id: WORKSPACE_B, title: "B1" });
    const ctxA = buildCtx(WORKSPACE_A);

    await expect(docDelete.handler(ctxA, { doc_id: DOC_B1 })).rejects.toBeInstanceOf(NotFoundError);

    // workspace-B's row untouched.
    const row = await driver
      .scoped(WORKSPACE_B)
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version"])
      .where("id", "=", DOC_B1)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.visibility_version).toBe(0);
  });

  it("rejects a non-UUIDv7 doc_id at the input schema", () => {
    const result = docDelete.input.safeParse({
      doc_id: "018f0000-0000-4000-a000-000000000001",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["doc_id"]);
    }
  });

  it("rejects a non-UUID string at the input schema", () => {
    const result = docDelete.input.safeParse({ doc_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown input keys (strict)", () => {
    const result = docDelete.input.safeParse({
      doc_id: DOC_A1,
      cascade: "hard",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("declares the correct registry metadata", () => {
    expect(docDelete.id).toBe("doc.delete");
    expect(docDelete.category).toBe("mutation");
    expect(docDelete.requires).toEqual(["doc:delete"]);
    expect(docDelete.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(docDelete.agentAllowed).toBeDefined();
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docDelete.audit.subjectFrom({ doc_id: DOC_A1 });
    expect(subject).toEqual({ kind: "doc", id: DOC_A1 });
  });

  it("emits doc.soft_delete on allow carrying doc_id + the handler deleted_at", () => {
    // Intentional asymmetry: capability id is `doc.delete` (user-
    // facing verb), audit effect kind is `doc.soft_delete`
    // (forensic-reader term; distinguishes from future `doc.purge`).
    // The effect carries the exact `deleted_at` the handler wrote so the
    // replay reducer reconstructs the ADR 0017 recovery anchor precisely —
    // the handler's clock, not the audit row's `created_at` (Codex review
    // HIGH 4).
    const effect = docDelete.audit.effectOnAllow(
      { doc_id: DOC_A1 },
      {
        doc_id: DOC_A1,
        deleted_at: 2_000_000,
        visibility_version: 4,
      },
    );
    expect(effect.kind).toBe("doc.soft_delete");
    if (effect.kind === "doc.soft_delete") {
      expect(effect.doc_id).toBe(DOC_A1);
      expect(effect.deleted_at).toBe(2_000_000);
    }
  });

  it("emits a deny effect carrying the reason code", () => {
    const effect = docDelete.audit.effectOnDeny(
      { doc_id: DOC_A1 },
      { kind: "missing_scope", required: ["doc:delete"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.delete");
      expect(effect.required_scopes).toEqual(["doc:delete"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    const effect = docDelete.audit.effectOnError(
      { doc_id: DOC_A1 },
      { kind: "not_found", subject_kind: "doc", subject_id: DOC_A1 },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.delete");
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("is not collapsible (mutations never collapse — F2)", () => {
    expect(docDelete.audit.collapsePolicy.collapsible).toBe(false);
  });
});
