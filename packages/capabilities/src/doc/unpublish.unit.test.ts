/**
 * `doc.unpublish` — capability-level integration test.
 *
 * Mirror of `doc.publish.unit.test.ts`. Exercises the handler against
 * real in-memory SQLite. No sync service needed (metadata-only
 * mutation; no `ctx.transact`). Layer-2 tenant isolation is owned by
 * `packages/db/src/tenant.unit.test.ts`; here we confirm the capability
 * composes with that layer (workspace-A ctx cannot unpublish workspace-B
 * docs).
 *
 * Dispatcher wiring (zod parse, audit row emit, write-path tx) is the
 * dispatcher's test.
 */

import { createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { type CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docUnpublish } from "./unpublish";

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
    transact: () => {
      throw new Error("doc.unpublish: handler must not call ctx.transact (metadata-only)");
    },
    outbox: () => {
      /* no outbox emissions in v1 */
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

describe("doc.unpublish", () => {
  it("flips visibility to workspace, bumps visibility_version, returns the post-state", async () => {
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Published",
      visibility: "public",
      visibility_version: 3,
    });

    const ctx = buildCtx(WORKSPACE_A, () => 2_000_000);
    const out = await docUnpublish.handler(ctx, { doc_id: DOC_A1 });

    expect(out).toEqual({
      doc_id: DOC_A1,
      visibility: "workspace",
      visibility_version: 4,
    });

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["visibility", "visibility_version", "updated_at"])
      .where("id", "=", DOC_A1)
      .executeTakeFirstOrThrow();
    expect(row.visibility).toBe("workspace");
    expect(row.visibility_version).toBe(4);
    expect(row.updated_at).toBe(2_000_000);
  });

  it("is idempotent at the state level (already-workspace bumps version anyway)", async () => {
    // F5 symmetric to publish's always-bump idempotency. Re-asserting
    // the workspace state still bumps visibility_version so any cache
    // keyed on it invalidates.
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Already workspace",
      visibility: "workspace",
      visibility_version: 7,
    });

    const ctx = buildCtx(WORKSPACE_A, () => 3_000_000);
    const out = await docUnpublish.handler(ctx, { doc_id: DOC_A1 });

    expect(out.visibility).toBe("workspace");
    expect(out.visibility_version).toBe(8);
  });

  it("unpublishes a private doc back to workspace (narrow inverse of publish)", async () => {
    // A doc that was previously `private` should also land on
    // `workspace` on unpublish. The capability's contract is "restore
    // the workspace-default visibility", not "undo the last publish."
    // A caller wanting `private` would use a future
    // `doc.set_visibility` capability — not unpublish.
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Previously private",
      visibility: "private",
      visibility_version: 2,
    });

    const ctx = buildCtx(WORKSPACE_A);
    const out = await docUnpublish.handler(ctx, { doc_id: DOC_A1 });

    expect(out.visibility).toBe("workspace");
    expect(out.visibility_version).toBe(3);
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    await expect(docUnpublish.handler(ctx, { doc_id: DOC_MISSING })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("treats soft-deleted docs as not found", async () => {
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Trashed",
      visibility: "public",
      deleted_at: 999,
    });
    const ctx = buildCtx(WORKSPACE_A);
    await expect(docUnpublish.handler(ctx, { doc_id: DOC_A2_DELETED })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // And the row stays untouched — the soft-deleted doc must not
    // have its visibility flipped through an error path.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["visibility", "visibility_version"])
      .where("id", "=", DOC_A2_DELETED)
      .executeTakeFirstOrThrow();
    expect(row.visibility).toBe("public");
    expect(row.visibility_version).toBe(0);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot unpublish workspace-B doc", async () => {
    await seedDocRow({
      id: DOC_B1,
      workspace_id: WORKSPACE_B,
      title: "B1",
      visibility: "public",
    });
    const ctxA = buildCtx(WORKSPACE_A);
    await expect(docUnpublish.handler(ctxA, { doc_id: DOC_B1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // workspace-B's row untouched.
    const row = await driver
      .scoped(WORKSPACE_B)
      .selectFrom("docs")
      .select(["visibility", "visibility_version"])
      .where("id", "=", DOC_B1)
      .executeTakeFirstOrThrow();
    expect(row.visibility).toBe("public");
    expect(row.visibility_version).toBe(0);
  });

  it("rejects a non-UUIDv7 doc_id at the input schema", () => {
    const result = docUnpublish.input.safeParse({
      doc_id: "018f0000-0000-4000-a000-000000000001",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["doc_id"]);
    }
  });

  it("rejects a non-UUID string at the input schema", () => {
    const result = docUnpublish.input.safeParse({ doc_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown input keys (strict)", () => {
    const result = docUnpublish.input.safeParse({
      doc_id: DOC_A1,
      visibility: "workspace",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("declares the correct registry metadata", () => {
    expect(docUnpublish.id).toBe("doc.unpublish");
    expect(docUnpublish.category).toBe("mutation");
    expect(docUnpublish.requires).toEqual(["doc:publish"]);
    expect(docUnpublish.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(docUnpublish.agentAllowed).toBeDefined();
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docUnpublish.audit.subjectFrom({ doc_id: DOC_A1 });
    expect(subject).toEqual({ kind: "doc", id: DOC_A1 });
  });

  it("emits doc.unpublish on allow with doc_id (no timestamp field)", () => {
    const effect = docUnpublish.audit.effectOnAllow(
      { doc_id: DOC_A1 },
      {
        doc_id: DOC_A1,
        visibility: "workspace",
        visibility_version: 4,
      },
    );
    expect(effect.kind).toBe("doc.unpublish");
    if (effect.kind === "doc.unpublish") {
      expect(effect.doc_id).toBe(DOC_A1);
      // Confirm the effect shape deliberately carries no timestamp
      // field — the audit envelope's `created_at` is the source of
      // truth for "when this happened" (target DDL has no
      // `unpublished_at` on the docs row).
      expect(Object.keys(effect)).toEqual(["kind", "doc_id"]);
    }
  });

  it("emits a deny effect carrying the reason code", () => {
    const effect = docUnpublish.audit.effectOnDeny(
      { doc_id: DOC_A1 },
      { kind: "missing_scope", required: ["doc:publish"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.unpublish");
      expect(effect.required_scopes).toEqual(["doc:publish"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    const effect = docUnpublish.audit.effectOnError(
      { doc_id: DOC_A1 },
      { kind: "not_found", subject_kind: "doc", subject_id: DOC_A1 },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.unpublish");
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("is not collapsible (mutations never collapse — F2)", () => {
    expect(docUnpublish.audit.collapsePolicy.collapsible).toBe(false);
  });
});
