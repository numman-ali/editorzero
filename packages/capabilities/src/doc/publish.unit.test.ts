/**
 * `doc.publish` — capability-level integration test (ADR 0040 Step 5).
 *
 * Exercises the handler against real in-memory SQLite. No sync service
 * is needed (metadata-only mutation; no `ctx.transact` call). Layer-2
 * tenant isolation is owned by `packages/db/src/tenant.unit.test.ts`;
 * here we confirm the capability composes with that layer (workspace-A
 * ctx cannot publish workspace-B docs).
 *
 * Step-5 semantics under test: publish mints `published_slug` (internal
 * slug, collision-suffixed against the LIVE published set), stamps
 * `published_at`, and bumps `render_version` — it never touches
 * `access_mode` (publish is the orthogonal dimension). Re-publish keeps
 * the existing slug + timestamp (URL stability) and only bumps the
 * version.
 *
 * Dispatcher wiring (zod parse, audit row emit, write-path tx) is the
 * dispatcher's test.
 */

import { createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docPublish } from "./publish";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2_DELETED = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d3");
const DOC_A3 = DocId("018f0000-0000-7000-8000-0000000000d4");
const DOC_A4 = DocId("018f0000-0000-7000-8000-0000000000d5");
const DOC_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");
// Free TEXT in the standalone DOCS_DDL fixture (no FK) — used to place
// same-slugged docs in different collections, the legitimate way two
// docs share an internal slug (per-collection uniqueness).
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
    // `doc.publish` is a metadata-only mutation — invoking `ctx.transact`
    // would violate the allowlist in `METADATA_ONLY_CAPABILITIES`. The
    // handler never calls it; this stub throws so a regression (handler
    // quietly starts calling transact) surfaces as a test failure, not a
    // silent passing run against a noop.
    transact: () => {
      throw new Error("doc.publish: handler must not call ctx.transact (metadata-only)");
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

describe("doc.publish", () => {
  it("mints published_slug from the internal slug, stamps published_at, bumps render_version", async () => {
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Draft",
      render_version: 3,
    });

    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A, () => 2_000_000);
    const out = await docPublish.handler(ctx, { doc_id: DOC_A1 });

    expect(out).toEqual({
      doc_id: DOC_A1,
      published_slug: "draft",
      published_at: 2_000_000,
      render_version: 4,
    });

    // Verify the docs row was actually updated (not just a projection) —
    // and that `access_mode` was NOT touched (publish is orthogonal).
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["access_mode", "published_slug", "published_at", "render_version", "updated_at"])
      .where("id", "=", DOC_A1)
      .executeTakeFirstOrThrow();
    expect(row.access_mode).toBe("space");
    expect(row.published_slug).toBe("draft");
    expect(row.published_at).toBe(2_000_000);
    expect(row.render_version).toBe(4);
    expect(row.updated_at).toBe(2_000_000);

    // Handler emits `doc.publish_changed` on the outbox seam — the
    // future renderer's invalidation signal. The post-update
    // `render_version` is the stable invalidation key; the event name
    // is shared with `doc.unpublish`, the null/non-null payload tells
    // the forwarder which side it landed on.
    expect(outboxEmits).toEqual([
      {
        event: "doc.publish_changed",
        payload: {
          doc_id: DOC_A1,
          published_slug: "draft",
          published_at: 2_000_000,
          render_version: 4,
        },
      },
    ]);
  });

  it("suffixes the published slug when the bare URL is taken by a LIVE published doc", async () => {
    // Two other docs already hold "guide" and "guide-2" publicly. The
    // internal slug is per-collection-unique but the PUBLISHED slug is
    // workspace-unique, so the third publisher gets "guide-3".
    await seedDocRow({
      id: DOC_A3,
      workspace_id: WORKSPACE_A,
      title: "Guide",
      slug: "guide",
      published_slug: "guide",
      published_at: 100,
    });
    await seedDocRow({
      id: DOC_A4,
      workspace_id: WORKSPACE_A,
      title: "Guide too",
      slug: "guide-too",
      published_slug: "guide-2",
      published_at: 200,
    });
    // Same internal slug as DOC_A3 is legal — different collection.
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Third guide",
      slug: "guide",
      collection_id: CollectionId(COLL_X),
    });

    const { ctx } = buildCtx(WORKSPACE_A, () => 5_000);
    const out = await docPublish.handler(ctx, { doc_id: DOC_A1 });
    expect(out.published_slug).toBe("guide-3");
    expect(out.published_at).toBe(5_000);
  });

  it("reuses a published slug released by a soft-deleted doc (partial-index semantics)", async () => {
    // A trashed doc no longer occupies the published namespace — the
    // mint filters `deleted_at IS NULL`, mirroring
    // `docs_published_slug_unique`'s WHERE clause.
    await seedDocRow({
      id: DOC_A3,
      workspace_id: WORKSPACE_A,
      title: "Old guide",
      slug: "old",
      published_slug: "guide",
      published_at: 100,
      deleted_at: 900,
    });
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Guide",
      slug: "guide",
    });

    const { ctx } = buildCtx(WORKSPACE_A, () => 5_000);
    const out = await docPublish.handler(ctx, { doc_id: DOC_A1 });
    expect(out.published_slug).toBe("guide");
  });

  it("is idempotent: re-publish keeps the slug AND the original published_at, bumps the version", async () => {
    // URL stability — a live public link must never rotate out from
    // under its readers; "first published" is a fact, not a counter.
    // F5 — `render_version` is a stable signal that *something*
    // happened, so it moves anyway and any cache keyed on it
    // invalidates.
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Already public",
      slug: "already-renamed", // internal slug moved since first publish
      published_slug: "already-public",
      published_at: 111,
      render_version: 7,
    });

    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A, () => 3_000_000);
    const out = await docPublish.handler(ctx, { doc_id: DOC_A1 });

    expect(out).toEqual({
      doc_id: DOC_A1,
      published_slug: "already-public",
      published_at: 111,
      render_version: 8,
    });
    expect(outboxEmits).toEqual([
      {
        event: "doc.publish_changed",
        payload: {
          doc_id: DOC_A1,
          published_slug: "already-public",
          published_at: 111,
          render_version: 8,
        },
      },
    ]);
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A);
    await expect(docPublish.handler(ctx, { doc_id: DOC_MISSING })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // The handler throws before reaching the `ctx.outbox` call; nothing
    // queued means the dispatcher has nothing to flush, which is the
    // single-tx atomicity guarantee (F10/F31) — a failed mutation must
    // not leak a `doc.publish_changed` event.
    expect(outboxEmits).toEqual([]);
  });

  it("treats soft-deleted docs as not found (publish is exposure, not resurrection)", async () => {
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Trashed",
      deleted_at: 999,
    });
    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A);
    await expect(docPublish.handler(ctx, { doc_id: DOC_A2_DELETED })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // And the row must remain un-mutated — a soft-deleted doc should
    // not gain a publish dimension through an error path.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["published_slug", "published_at", "render_version"])
      .where("id", "=", DOC_A2_DELETED)
      .executeTakeFirstOrThrow();
    expect(row.published_slug).toBeNull();
    expect(row.published_at).toBeNull();
    expect(row.render_version).toBe(0);
    expect(outboxEmits).toEqual([]);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot publish workspace-B doc", async () => {
    await seedDocRow({ id: DOC_B1, workspace_id: WORKSPACE_B, title: "B1" });
    const { ctx: ctxA, outboxEmits } = buildCtx(WORKSPACE_A);

    // Same UUID, different workspace — the WorkspaceScopingPlugin
    // injects `workspace_id = A` on the SELECT; the row (owned by B)
    // is invisible and the handler throws `NotFoundError` rather than
    // leak cross-tenant existence.
    await expect(docPublish.handler(ctxA, { doc_id: DOC_B1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // And workspace-B's row must remain untouched.
    const row = await driver
      .scoped(WORKSPACE_B)
      .selectFrom("docs")
      .select(["published_slug", "published_at", "render_version"])
      .where("id", "=", DOC_B1)
      .executeTakeFirstOrThrow();
    expect(row.published_slug).toBeNull();
    expect(row.published_at).toBeNull();
    expect(row.render_version).toBe(0);
    // No outbox emission either — the cross-tenant shape must not
    // leak a `doc.publish_changed` event tagged with workspace-A's
    // `ctx.tenant.workspace_id` for a row owned by B.
    expect(outboxEmits).toEqual([]);
  });

  it("the published namespace is per-workspace: B's published slug does not suffix A's mint", async () => {
    await seedDocRow({
      id: DOC_B1,
      workspace_id: WORKSPACE_B,
      title: "Guide",
      slug: "guide",
      published_slug: "guide",
      published_at: 50,
    });
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Guide", slug: "guide" });

    const { ctx } = buildCtx(WORKSPACE_A, () => 5_000);
    const out = await docPublish.handler(ctx, { doc_id: DOC_A1 });
    // The mint SELECT runs through the scoped handle — workspace B's
    // "guide" is invisible, so A gets the bare URL.
    expect(out.published_slug).toBe("guide");
  });

  it("rejects a non-UUIDv7 doc_id at the input schema", () => {
    const result = docPublish.input.safeParse({
      doc_id: "018f0000-0000-4000-a000-000000000001",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["doc_id"]);
    }
  });

  it("rejects a non-UUID string at the input schema", () => {
    const result = docPublish.input.safeParse({ doc_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown input keys (strict)", () => {
    const result = docPublish.input.safeParse({
      doc_id: DOC_A1,
      access_mode: "private",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("declares the correct registry metadata", () => {
    expect(docPublish.id).toBe("doc.publish");
    expect(docPublish.category).toBe("mutation");
    expect(docPublish.requires).toEqual(["doc:publish"]);
    expect(docPublish.surfaces).toEqual(["api", "cli", "mcp"]);
    // Present so agents with `doc:publish` in their tier can dispatch.
    expect(docPublish.agentAllowed).toBeDefined();
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docPublish.audit.subjectFrom({ doc_id: DOC_A1 });
    expect(subject).toEqual({ kind: "doc", id: DOC_A1 });
  });

  it("emits doc.publish on allow carrying the handler-computed slug + timestamp", () => {
    // `published_slug` is handler-COMPUTED (collision-suffixed), so the
    // effect must carry it — replay can never re-derive it.
    const effect = docPublish.audit.effectOnAllow(
      { doc_id: DOC_A1 },
      {
        doc_id: DOC_A1,
        published_slug: "draft-2",
        published_at: 2_000_000,
        render_version: 4,
      },
    );
    expect(effect.kind).toBe("doc.publish");
    if (effect.kind === "doc.publish") {
      expect(effect.doc_id).toBe(DOC_A1);
      expect(effect.published_slug).toBe("draft-2");
      expect(effect.published_at).toBe(2_000_000);
    }
  });

  it("emits a deny effect carrying the reason code", () => {
    const effect = docPublish.audit.effectOnDeny(
      { doc_id: DOC_A1 },
      { kind: "missing_scope", required: ["doc:publish"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.publish");
      expect(effect.required_scopes).toEqual(["doc:publish"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    const effect = docPublish.audit.effectOnError(
      { doc_id: DOC_A1 },
      { kind: "not_found", subject_kind: "doc", subject_id: DOC_A1 },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.publish");
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("is not collapsible (mutations never collapse — F2)", () => {
    expect(docPublish.audit.collapsePolicy.collapsible).toBe(false);
  });
});
