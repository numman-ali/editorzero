/**
 * `doc.move` — capability-level integration test.
 *
 * Exercises the handler against a real in-memory SQLite driver. Covers:
 *
 *   - 404 on missing/soft-deleted doc
 *   - 404 on missing/soft-deleted target collection
 *   - target-scope slug collision (typed 409 via `SlugCollisionError`)
 *   - happy-path move to root, move to a collection, move between
 *     collections, no-op same-scope move
 *   - input validation (strict, UUIDv7, explicit null for root)
 *   - registry metadata + audit projections
 */

import { COLLECTIONS_DDL, createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError, SlugCollisionError } from "@editorzero/errors";
import { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docMove } from "./move";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const COLL_A = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const COLL_B = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const COLL_DELETED = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const COLL_MISSING = CollectionId("018f0000-0000-7000-8000-0000000000c9");

const DOC_ROOT = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_IN_A = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_DELETED = DocId("018f0000-0000-7000-8000-0000000000d3");
const DOC_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
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

function buildCtx(principal: Principal, now = () => 42): CapabilityContext {
  return {
    principal,
    tenant: { workspace_id: principal.workspace_id },
    db: driver.scoped(principal.workspace_id),
    transact: () => {
      throw new Error("doc.move must not call ctx.transact (metadata-only)");
    },
    outbox: () => {
      /* no outbox events in v1 */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now,
  };
}

async function seed() {
  const a = driver.scoped(WORKSPACE_A);
  await a
    .insertInto("collections")
    .values([
      {
        id: COLL_A,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "A",
        slug: "a",
        order_key: "a0",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: COLL_B,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "B",
        slug: "b",
        order_key: "a1",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: COLL_DELETED,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Trashed",
        slug: "trashed",
        order_key: "a2",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 500,
      },
    ])
    .execute();

  await a
    .insertInto("docs")
    .values([
      {
        id: DOC_ROOT,
        workspace_id: WORKSPACE_A,
        collection_id: null,
        title: "Root Doc",
        slug: "root-doc",
        order_key: DOC_ROOT,
        visibility: "workspace",
        visibility_version: 0,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: DOC_IN_A,
        workspace_id: WORKSPACE_A,
        collection_id: COLL_A,
        title: "Doc in A",
        slug: "doc-in-a",
        order_key: DOC_IN_A,
        visibility: "workspace",
        visibility_version: 0,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: DOC_DELETED,
        workspace_id: WORKSPACE_A,
        collection_id: COLL_A,
        title: "Trashed Doc",
        slug: "trashed-doc",
        order_key: DOC_DELETED,
        visibility: "workspace",
        visibility_version: 0,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 500,
      },
    ])
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.move", () => {
  describe("happy path", () => {
    it("moves a doc into a collection", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await docMove.handler(ctx, {
        doc_id: DOC_ROOT,
        new_collection_id: COLL_A,
      });
      expect(out.doc_id).toBe(DOC_ROOT);
      expect(out.new_collection_id).toBe(COLL_A);
      expect(out.updated_at).toBe(42);
      expect(out.new_order_key).toBeTruthy();

      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["collection_id", "order_key", "updated_at"])
        .where("id", "=", DOC_ROOT)
        .executeTakeFirst();
      expect(row?.collection_id).toBe(COLL_A);
      expect(row?.updated_at).toBe(42);
      expect(row?.order_key).toBe(out.new_order_key);
    });

    it("moves a doc out of a collection to workspace root (new_collection_id=null)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await docMove.handler(ctx, {
        doc_id: DOC_IN_A,
        new_collection_id: null,
      });
      expect(out.new_collection_id).toBeNull();
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["collection_id"])
        .where("id", "=", DOC_IN_A)
        .executeTakeFirst();
      expect(row?.collection_id).toBeNull();
    });

    it("moves a doc between collections", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await docMove.handler(ctx, { doc_id: DOC_IN_A, new_collection_id: COLL_B });
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["collection_id"])
        .where("id", "=", DOC_IN_A)
        .executeTakeFirst();
      expect(row?.collection_id).toBe(COLL_B);
    });

    it("accepts a no-op same-scope move (re-seats order_key / updated_at)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const before = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["order_key"])
        .where("id", "=", DOC_IN_A)
        .executeTakeFirst();
      const out = await docMove.handler(ctx, {
        doc_id: DOC_IN_A,
        new_collection_id: COLL_A, // same collection
      });
      expect(out.new_order_key).not.toBe(before?.order_key);
      expect(out.updated_at).toBe(42);
    });
  });

  describe("404 handling", () => {
    it("throws NotFoundError when the doc is missing", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        docMove.handler(ctx, { doc_id: DOC_MISSING, new_collection_id: null }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the doc is soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        docMove.handler(ctx, { doc_id: DOC_DELETED, new_collection_id: null }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the target collection is missing", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        docMove.handler(ctx, { doc_id: DOC_ROOT, new_collection_id: COLL_MISSING }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the target collection is soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        docMove.handler(ctx, { doc_id: DOC_ROOT, new_collection_id: COLL_DELETED }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("target-scope slug collision", () => {
    it("refuses when the target collection already has a sibling doc with the same slug", async () => {
      await seed();
      // Insert a doc in COLL_B with slug matching DOC_IN_A's slug.
      const clash = DocId("018f0000-0000-7000-8000-0000000000e1");
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("docs")
        .values({
          id: clash,
          workspace_id: WORKSPACE_A,
          collection_id: COLL_B,
          title: "Clash",
          slug: "doc-in-a",
          order_key: clash,
          visibility: "workspace",
          visibility_version: 0,
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      const ctx = buildCtx(userPrincipal());
      await expect(
        docMove.handler(ctx, { doc_id: DOC_IN_A, new_collection_id: COLL_B }),
      ).rejects.toBeInstanceOf(SlugCollisionError);
    });

    it("refuses workspace-root slug collision when moving doc to root", async () => {
      await seed();
      // DOC_IN_A slug "doc-in-a" — insert a root-level doc with the same slug.
      const clash = DocId("018f0000-0000-7000-8000-0000000000e2");
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("docs")
        .values({
          id: clash,
          workspace_id: WORKSPACE_A,
          collection_id: null,
          title: "Root Clash",
          slug: "doc-in-a",
          order_key: clash,
          visibility: "workspace",
          visibility_version: 0,
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      const ctx = buildCtx(userPrincipal());
      await expect(
        docMove.handler(ctx, { doc_id: DOC_IN_A, new_collection_id: null }),
      ).rejects.toBeInstanceOf(SlugCollisionError);
    });

    it("error carries slug + target collection context", async () => {
      await seed();
      const clash = DocId("018f0000-0000-7000-8000-0000000000e3");
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("docs")
        .values({
          id: clash,
          workspace_id: WORKSPACE_A,
          collection_id: COLL_B,
          title: "clash",
          slug: "doc-in-a",
          order_key: clash,
          visibility: "workspace",
          visibility_version: 0,
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      const ctx = buildCtx(userPrincipal());
      try {
        await docMove.handler(ctx, { doc_id: DOC_IN_A, new_collection_id: COLL_B });
        throw new Error("expected SlugCollisionError");
      } catch (err) {
        expect(err).toBeInstanceOf(SlugCollisionError);
        if (err instanceof SlugCollisionError) {
          expect(err.slug).toBe("doc-in-a");
          expect(err.parent_kind).toBe("collection");
          expect(err.parent_id).toBe(COLL_B);
        }
      }
    });

    it("same-scope move does not trigger slug collision against self", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await docMove.handler(ctx, {
        doc_id: DOC_IN_A,
        new_collection_id: COLL_A,
      });
      expect(out.doc_id).toBe(DOC_IN_A);
    });
  });

  describe("input validation", () => {
    it("rejects unknown fields via strict()", () => {
      const result = docMove.input.safeParse({
        doc_id: DOC_ROOT,
        new_collection_id: null,
        stray: 1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUIDv7 doc_id", () => {
      const result = docMove.input.safeParse({
        doc_id: "not-a-uuid",
        new_collection_id: null,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUIDv7 new_collection_id", () => {
      const result = docMove.input.safeParse({
        doc_id: DOC_ROOT,
        new_collection_id: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });

    it("requires new_collection_id explicitly (omitted → invalid)", () => {
      const result = docMove.input.safeParse({
        doc_id: DOC_ROOT,
      });
      expect(result.success).toBe(false);
    });

    it("accepts explicit null for new_collection_id (workspace-root move)", () => {
      const result = docMove.input.safeParse({
        doc_id: DOC_ROOT,
        new_collection_id: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("registry metadata + audit projections", () => {
    it("declares the expected registry metadata", () => {
      expect(docMove.id).toBe("doc.move");
      expect(docMove.category).toBe("mutation");
      expect(docMove.requires).toEqual(["doc:write"]);
      expect(docMove.surfaces).toEqual(["api", "cli", "mcp"]);
    });

    it("emits the doc.move effect on allow with new_collection_id + new_order_key", () => {
      const effect = docMove.audit.effectOnAllow(
        { doc_id: DOC_ROOT, new_collection_id: COLL_A },
        {
          doc_id: DOC_ROOT,
          new_collection_id: COLL_A,
          new_order_key: "018f0000-0000-7000-8000-000000000111",
          updated_at: 42,
        },
      );
      expect(effect.kind).toBe("doc.move");
      if (effect.kind === "doc.move") {
        expect(effect.doc_id).toBe(DOC_ROOT);
        expect(effect.new_collection_id).toBe(COLL_A);
        expect(effect.new_order_key).toBe("018f0000-0000-7000-8000-000000000111");
      }
    });

    it("projects a per-doc subject", () => {
      const subject = docMove.audit.subjectFrom({
        doc_id: DOC_ROOT,
        new_collection_id: null,
      });
      expect(subject.kind).toBe("doc");
      if (subject.kind === "doc") {
        expect(subject.id).toBe(DOC_ROOT);
      }
    });

    it("emits a deny effect carrying the reason code", () => {
      const effect = docMove.audit.effectOnDeny(
        { doc_id: DOC_ROOT, new_collection_id: null },
        { kind: "missing_scope", required: ["doc:write"], principal_scopes: [] },
      );
      expect(effect.kind).toBe("deny");
      if (effect.kind === "deny") {
        expect(effect.capability).toBe("doc.move");
        expect(effect.required_scopes).toEqual(["doc:write"]);
        expect(effect.reason_code).toBe("missing_scope");
      }
    });

    it("preserves HandlerError kind via effectOnError", () => {
      const effect = docMove.audit.effectOnError(
        { doc_id: DOC_ROOT, new_collection_id: null },
        { kind: "conflict" },
      );
      expect(effect.kind).toBe("error");
      if (effect.kind === "error") {
        expect(effect.capability).toBe("doc.move");
        expect(effect.error_code).toBe("conflict");
      }
    });

    it("is not collapsible (mutation)", () => {
      expect(docMove.audit.collapsePolicy.collapsible).toBe(false);
    });
  });
});
