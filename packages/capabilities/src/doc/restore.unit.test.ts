/**
 * `doc.restore` — capability-level integration test. Mirror of
 * `doc.delete`'s test posture. Metadata-only mutation, no sync
 * service; Layer-2 tenant isolation owned by
 * `packages/db/src/tenant.unit.test.ts`.
 */

import { COLLECTIONS_DDL, createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError, ParentDeletedError } from "@editorzero/errors";
import { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docRestore } from "./restore";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const DOC_A1_LIVE = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2_DELETED = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_B1_DELETED = DocId("018f0000-0000-7000-8000-0000000000d3");
const DOC_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(DOCS_DDL);
});

const LIVE_COLLECTION = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const DELETED_COLLECTION = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const MISSING_COLLECTION = CollectionId("018f0000-0000-7000-8000-0000000000c9");

async function seedCollection(params: {
  id: CollectionId;
  workspace_id: WorkspaceId;
  deleted_at?: number | null;
}) {
  await driver
    .scoped(params.workspace_id)
    .insertInto("collections")
    .values({
      id: params.id,
      workspace_id: params.workspace_id,
      parent_id: null,
      title: "Collection",
      slug: params.id,
      order_key: params.id,
      created_by: ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at: params.deleted_at ?? null,
    })
    .execute();
}

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
    transact: () => {
      throw new Error("doc.restore: handler must not call ctx.transact (metadata-only)");
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

describe("doc.restore", () => {
  it("clears deleted_at, bumps visibility_version, returns the post-state", async () => {
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Trashed",
      deleted_at: 999,
      visibility_version: 3,
    });

    const ctx = buildCtx(WORKSPACE_A, () => 4_000_000);
    const out = await docRestore.handler(ctx, { doc_id: DOC_A2_DELETED });

    expect(out).toEqual({
      doc_id: DOC_A2_DELETED,
      visibility_version: 4,
    });

    // Verify the docs row was actually updated — deleted_at cleared,
    // version bumped, updated_at advanced.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version", "updated_at"])
      .where("id", "=", DOC_A2_DELETED)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.visibility_version).toBe(4);
    expect(row.updated_at).toBe(4_000_000);
  });

  it("bumps visibility_version so public-route cache invalidates on restore of a published doc (§5.4)", async () => {
    // The cache contract is symmetric to delete's: flipping the
    // public-route render back from "404" to "renders" requires a
    // version movement or the cached 404 sticks.
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Was public",
      visibility: "public",
      visibility_version: 11,
      deleted_at: 999,
    });

    const ctx = buildCtx(WORKSPACE_A, () => 5_000_000);
    const out = await docRestore.handler(ctx, { doc_id: DOC_A2_DELETED });
    expect(out.visibility_version).toBe(12);
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    await expect(docRestore.handler(ctx, { doc_id: DOC_MISSING })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("treats already-live docs as 404 (honest projection; no no-op restore rows)", async () => {
    // Symmetric to delete's already-deleted 404: restoring an already-
    // live doc has no state change, and surfacing 200 would muddy the
    // audit log with no-op restore rows. 404 is the honest projection.
    await seedDocRow({
      id: DOC_A1_LIVE,
      workspace_id: WORKSPACE_A,
      title: "Alive",
      visibility_version: 5,
    });
    const ctx = buildCtx(WORKSPACE_A, () => 5_000_000);
    await expect(docRestore.handler(ctx, { doc_id: DOC_A1_LIVE })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Row untouched — deleted_at still null, version not bumped.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version"])
      .where("id", "=", DOC_A1_LIVE)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.visibility_version).toBe(5);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot restore workspace-B doc", async () => {
    await seedDocRow({
      id: DOC_B1_DELETED,
      workspace_id: WORKSPACE_B,
      title: "B1 trashed",
      deleted_at: 888,
    });
    const ctxA = buildCtx(WORKSPACE_A);

    await expect(docRestore.handler(ctxA, { doc_id: DOC_B1_DELETED })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // workspace-B's row still trashed, untouched.
    const row = await driver
      .scoped(WORKSPACE_B)
      .selectFrom("docs")
      .select(["deleted_at", "visibility_version"])
      .where("id", "=", DOC_B1_DELETED)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBe(888);
    expect(row.visibility_version).toBe(0);
  });

  describe("parent-collection precondition (slice 2)", () => {
    it("restores a soft-deleted doc whose parent collection is live", async () => {
      await seedCollection({ id: LIVE_COLLECTION, workspace_id: WORKSPACE_A });
      await seedDocRow({
        id: DOC_A2_DELETED,
        workspace_id: WORKSPACE_A,
        title: "Trashed",
        collection_id: LIVE_COLLECTION,
        deleted_at: 999,
      });
      const ctx = buildCtx(WORKSPACE_A, () => 4_000_000);
      const out = await docRestore.handler(ctx, { doc_id: DOC_A2_DELETED });
      expect(out.doc_id).toBe(DOC_A2_DELETED);
    });

    it("refuses with ParentDeletedError when the parent collection is soft-deleted", async () => {
      await seedCollection({
        id: DELETED_COLLECTION,
        workspace_id: WORKSPACE_A,
        deleted_at: 500,
      });
      await seedDocRow({
        id: DOC_A2_DELETED,
        workspace_id: WORKSPACE_A,
        title: "Trashed",
        collection_id: DELETED_COLLECTION,
        deleted_at: 999,
      });
      const ctx = buildCtx(WORKSPACE_A);
      await expect(docRestore.handler(ctx, { doc_id: DOC_A2_DELETED })).rejects.toBeInstanceOf(
        ParentDeletedError,
      );
    });

    it("refuses with ParentDeletedError when the parent collection is missing (dangling)", async () => {
      // `docs.collection_id` has no DB FK in v1 — a dangling id can
      // arise via system-handle writes. The handler still refuses
      // rather than silently re-parenting.
      await seedDocRow({
        id: DOC_A2_DELETED,
        workspace_id: WORKSPACE_A,
        title: "Trashed",
        collection_id: MISSING_COLLECTION,
        deleted_at: 999,
      });
      const ctx = buildCtx(WORKSPACE_A);
      await expect(docRestore.handler(ctx, { doc_id: DOC_A2_DELETED })).rejects.toBeInstanceOf(
        ParentDeletedError,
      );
    });

    it("error carries the parent collection id + kind", async () => {
      await seedCollection({
        id: DELETED_COLLECTION,
        workspace_id: WORKSPACE_A,
        deleted_at: 500,
      });
      await seedDocRow({
        id: DOC_A2_DELETED,
        workspace_id: WORKSPACE_A,
        title: "Trashed",
        collection_id: DELETED_COLLECTION,
        deleted_at: 999,
      });
      const ctx = buildCtx(WORKSPACE_A);
      try {
        await docRestore.handler(ctx, { doc_id: DOC_A2_DELETED });
        throw new Error("expected ParentDeletedError");
      } catch (err) {
        expect(err).toBeInstanceOf(ParentDeletedError);
        if (err instanceof ParentDeletedError) {
          expect(err.parent_kind).toBe("collection");
          expect(err.parent_id).toBe(DELETED_COLLECTION);
        }
      }
    });

    it("leaves the doc soft-deleted after refusal (no partial writes)", async () => {
      await seedCollection({
        id: DELETED_COLLECTION,
        workspace_id: WORKSPACE_A,
        deleted_at: 500,
      });
      await seedDocRow({
        id: DOC_A2_DELETED,
        workspace_id: WORKSPACE_A,
        title: "Trashed",
        collection_id: DELETED_COLLECTION,
        visibility_version: 7,
        deleted_at: 999,
      });
      const ctx = buildCtx(WORKSPACE_A);
      await expect(docRestore.handler(ctx, { doc_id: DOC_A2_DELETED })).rejects.toBeInstanceOf(
        ParentDeletedError,
      );
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["deleted_at", "visibility_version"])
        .where("id", "=", DOC_A2_DELETED)
        .executeTakeFirstOrThrow();
      expect(row.deleted_at).toBe(999);
      expect(row.visibility_version).toBe(7);
    });

    it("has no precondition when collection_id is null (workspace-root doc)", async () => {
      // Existing `doc.restore` behavior — workspace-root docs restore
      // without any parent check. Regression guard: the new precondition
      // only fires when `collection_id !== null`.
      await seedDocRow({
        id: DOC_A2_DELETED,
        workspace_id: WORKSPACE_A,
        title: "Trashed",
        collection_id: null,
        deleted_at: 999,
      });
      const ctx = buildCtx(WORKSPACE_A);
      const out = await docRestore.handler(ctx, { doc_id: DOC_A2_DELETED });
      expect(out.doc_id).toBe(DOC_A2_DELETED);
    });
  });

  it("rejects a non-UUIDv7 doc_id at the input schema", () => {
    const result = docRestore.input.safeParse({
      doc_id: "018f0000-0000-4000-a000-000000000001",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["doc_id"]);
    }
  });

  it("rejects a non-UUID string at the input schema", () => {
    const result = docRestore.input.safeParse({ doc_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown input keys (strict)", () => {
    const result = docRestore.input.safeParse({
      doc_id: DOC_A2_DELETED,
      cascade: "rebuild",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("declares the correct registry metadata", () => {
    expect(docRestore.id).toBe("doc.restore");
    expect(docRestore.category).toBe("mutation");
    expect(docRestore.requires).toEqual(["doc:delete"]);
    expect(docRestore.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(docRestore.agentAllowed).toBeDefined();
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docRestore.audit.subjectFrom({ doc_id: DOC_A2_DELETED });
    expect(subject).toEqual({ kind: "doc", id: DOC_A2_DELETED });
  });

  it("emits doc.restore on allow with doc_id (no timestamp field — envelope owns that)", () => {
    const effect = docRestore.audit.effectOnAllow(
      { doc_id: DOC_A2_DELETED },
      {
        doc_id: DOC_A2_DELETED,
        visibility_version: 4,
      },
    );
    expect(effect.kind).toBe("doc.restore");
    if (effect.kind === "doc.restore") {
      expect(effect.doc_id).toBe(DOC_A2_DELETED);
      // No `restored_at` field on the effect union.
      expect((effect as { restored_at?: number }).restored_at).toBeUndefined();
    }
  });

  it("emits a deny effect carrying the reason code", () => {
    const effect = docRestore.audit.effectOnDeny(
      { doc_id: DOC_A2_DELETED },
      { kind: "missing_scope", required: ["doc:delete"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.restore");
      expect(effect.required_scopes).toEqual(["doc:delete"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    const effect = docRestore.audit.effectOnError(
      { doc_id: DOC_A2_DELETED },
      { kind: "not_found", subject_kind: "doc", subject_id: DOC_A2_DELETED },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.restore");
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("is not collapsible (mutations never collapse — F2)", () => {
    expect(docRestore.audit.collapsePolicy.collapsible).toBe(false);
  });
});
