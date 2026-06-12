/**
 * `doc.unpublish` — capability-level integration test (ADR 0040 Step 5).
 *
 * Pair of `publish.unit.test.ts`; same harness shape. Step-5 semantics
 * under test: unpublish clears `published_slug` + `published_at`
 * (releasing the public URL for reuse), bumps `render_version`, and
 * never touches `access_mode`.
 */

import { createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docPublish } from "./publish";
import { docUnpublish } from "./unpublish";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2_DELETED = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d3");
const DOC_A3 = DocId("018f0000-0000-7000-8000-0000000000d4");
const DOC_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");
// Free TEXT in the standalone DOCS_DDL fixture (no FK) — places the
// same-slugged second doc in a collection (per-collection uniqueness).
const COLL_X = "018f0000-0000-7000-8000-0000000000c1";

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

interface OutboxCapture {
  readonly event: string;
  readonly payload: unknown;
}

function buildCtx(
  workspace_id: WorkspaceId,
  now: () => number = () => 1000,
): { readonly ctx: CapabilityContext; readonly outboxEmits: readonly OutboxCapture[] } {
  const outboxEmits: OutboxCapture[] = [];
  const ctx: CapabilityContext = {
    principal: userPrincipal(),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    // Metadata-only mutation — a handler that starts calling
    // `ctx.transact` must surface as a test failure, not a silent noop.
    transact: () => {
      throw new Error("doc.unpublish: handler must not call ctx.transact (metadata-only)");
    },
    outbox: (event, payload) => {
      outboxEmits.push({ event, payload });
    },
    logger: noopLogger,
    tracer: noopTracer,
    now,
  };
  return { ctx, outboxEmits };
}

async function seedDocRow(params: {
  id: DocId;
  workspace_id: WorkspaceId;
  title: string;
  slug?: string;
  published_slug?: string | null;
  published_at?: number | null;
  render_version?: number;
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
      slug: params.slug ?? params.title.toLowerCase(),
      order_key: params.id,
      access_mode: "space",
      published_slug: params.published_slug ?? null,
      published_at: params.published_at ?? null,
      render_version: params.render_version ?? 0,
      created_by: ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at: params.deleted_at ?? null,
    })
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.unpublish", () => {
  it("clears published_slug + published_at, bumps render_version, leaves access_mode alone", async () => {
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Live",
      published_slug: "live",
      published_at: 111,
      render_version: 3,
    });

    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A, () => 2_000_000);
    const out = await docUnpublish.handler(ctx, { doc_id: DOC_A1 });

    expect(out).toEqual({
      doc_id: DOC_A1,
      published_slug: null,
      published_at: null,
      render_version: 4,
    });

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["access_mode", "published_slug", "published_at", "render_version", "updated_at"])
      .where("id", "=", DOC_A1)
      .executeTakeFirstOrThrow();
    expect(row.access_mode).toBe("space");
    expect(row.published_slug).toBeNull();
    expect(row.published_at).toBeNull();
    expect(row.render_version).toBe(4);
    expect(row.updated_at).toBe(2_000_000);

    expect(outboxEmits).toEqual([
      {
        event: "doc.publish_changed",
        payload: {
          doc_id: DOC_A1,
          published_slug: null,
          published_at: null,
          render_version: 4,
        },
      },
    ]);
  });

  it("releases the public URL: another doc can claim the bare slug afterwards", async () => {
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Guide",
      slug: "guide",
      published_slug: "guide",
      published_at: 100,
    });
    // Same internal slug as DOC_A1 is legal — different collection.
    await seedDocRow({
      id: DOC_A3,
      workspace_id: WORKSPACE_A,
      title: "New guide",
      slug: "guide",
      collection_id: CollectionId(COLL_X),
    });

    const { ctx } = buildCtx(WORKSPACE_A, () => 5_000);
    await docUnpublish.handler(ctx, { doc_id: DOC_A1 });
    const out = await docPublish.handler(ctx, { doc_id: DOC_A3 });
    // No suffix — DOC_A1's claim is gone, the namespace really freed.
    expect(out.published_slug).toBe("guide");
  });

  it("is idempotent at the state level (already-unpublished bumps version anyway)", async () => {
    // F5 — `render_version` is a stable signal that *something*
    // happened, not a change-detector. A caller re-asserting unpublish
    // should see the version move so any cache keyed on it invalidates.
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Never public",
      render_version: 7,
    });

    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A, () => 3_000_000);
    const out = await docUnpublish.handler(ctx, { doc_id: DOC_A1 });

    expect(out.published_slug).toBeNull();
    expect(out.published_at).toBeNull();
    expect(out.render_version).toBe(8);
    expect(outboxEmits).toEqual([
      {
        event: "doc.publish_changed",
        payload: { doc_id: DOC_A1, published_slug: null, published_at: null, render_version: 8 },
      },
    ]);
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A);
    await expect(docUnpublish.handler(ctx, { doc_id: DOC_MISSING })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Failed mutation must not leak a `doc.publish_changed` event
    // (single-tx atomicity — F10/F31).
    expect(outboxEmits).toEqual([]);
  });

  it("treats soft-deleted docs as not found (delete already cleared the publish dimension)", async () => {
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Trashed",
      deleted_at: 999,
    });
    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A);
    await expect(docUnpublish.handler(ctx, { doc_id: DOC_A2_DELETED })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["published_slug", "published_at", "render_version"])
      .where("id", "=", DOC_A2_DELETED)
      .executeTakeFirstOrThrow();
    expect(row.render_version).toBe(0);
    expect(outboxEmits).toEqual([]);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot unpublish workspace-B doc", async () => {
    await seedDocRow({
      id: DOC_B1,
      workspace_id: WORKSPACE_B,
      title: "B1",
      published_slug: "b1",
      published_at: 50,
    });
    const { ctx: ctxA, outboxEmits } = buildCtx(WORKSPACE_A);

    await expect(docUnpublish.handler(ctxA, { doc_id: DOC_B1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Workspace-B's published state must remain untouched.
    const row = await driver
      .scoped(WORKSPACE_B)
      .selectFrom("docs")
      .select(["published_slug", "published_at", "render_version"])
      .where("id", "=", DOC_B1)
      .executeTakeFirstOrThrow();
    expect(row.published_slug).toBe("b1");
    expect(row.published_at).toBe(50);
    expect(row.render_version).toBe(0);
    expect(outboxEmits).toEqual([]);
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

  it("rejects unknown input keys (strict)", () => {
    const result = docUnpublish.input.safeParse({
      doc_id: DOC_A1,
      access_mode: "space",
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
    expect(docUnpublish.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(docUnpublish.agentAllowed).toBeDefined();
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docUnpublish.audit.subjectFrom({ doc_id: DOC_A1 });
    expect(subject).toEqual({ kind: "doc", id: DOC_A1 });
  });

  it("emits doc.unpublish on allow with just the target (the clear is deterministic)", () => {
    const effect = docUnpublish.audit.effectOnAllow(
      { doc_id: DOC_A1 },
      { doc_id: DOC_A1, published_slug: null, published_at: null, render_version: 4 },
    );
    expect(effect).toEqual({ kind: "doc.unpublish", doc_id: DOC_A1 });
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
