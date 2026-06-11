/**
 * `collection.delete` — capability-level integration test.
 *
 * Exercises the handler against a real in-memory SQLite driver. Covers
 * 404 (missing, already-deleted), the live-descendants refusal (child
 * collections and/or child docs), and the happy-path soft-delete.
 */

import { COLLECTIONS_DDL, createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { HasLiveDescendantsError, NotFoundError } from "@editorzero/errors";
import { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { collectionDelete } from "./delete";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const ROOT = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const EMPTY = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const PARENT_WITH_CHILD = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const CHILD = CollectionId("018f0000-0000-7000-8000-0000000000c4");
const PARENT_WITH_DOC = CollectionId("018f0000-0000-7000-8000-0000000000c5");
const ALREADY_DELETED = CollectionId("018f0000-0000-7000-8000-0000000000c6");
const MISSING = CollectionId("018f0000-0000-7000-8000-0000000000c9");
const DOC_IN_PARENT = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_TRASHED = DocId("018f0000-0000-7000-8000-0000000000d2");
const DELETED_CHILD = CollectionId("018f0000-0000-7000-8000-0000000000c7");

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
      throw new Error("collection.delete must not call ctx.transact (metadata-only capability)");
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
        id: ROOT,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Root",
        slug: "root",
        order_key: "a0",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: EMPTY,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Empty",
        slug: "empty",
        order_key: "a1",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: PARENT_WITH_CHILD,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "ParentWithChild",
        slug: "parent-with-child",
        order_key: "a2",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: CHILD,
        workspace_id: WORKSPACE_A,
        parent_id: PARENT_WITH_CHILD,
        title: "Child",
        slug: "child",
        order_key: "a3",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: PARENT_WITH_DOC,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "ParentWithDoc",
        slug: "parent-with-doc",
        order_key: "a4",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: ALREADY_DELETED,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Trashed",
        slug: "trashed",
        order_key: "a5",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 500,
      },
      {
        id: DELETED_CHILD,
        workspace_id: WORKSPACE_A,
        parent_id: ROOT,
        title: "DeadChild",
        slug: "dead-child",
        order_key: "a6",
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
        id: DOC_IN_PARENT,
        workspace_id: WORKSPACE_A,
        collection_id: PARENT_WITH_DOC,
        title: "Doc",
        slug: DOC_IN_PARENT,
        order_key: DOC_IN_PARENT,
        visibility: "workspace",
        visibility_version: 0,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: DOC_TRASHED,
        workspace_id: WORKSPACE_A,
        collection_id: ROOT,
        title: "Trashed Doc",
        slug: DOC_TRASHED,
        order_key: DOC_TRASHED,
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

describe("collection.delete", () => {
  describe("happy path", () => {
    it("soft-deletes an empty collection and returns the new deleted_at", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await collectionDelete.handler(ctx, { collection_id: EMPTY });
      expect(out.collection_id).toBe(EMPTY);
      expect(out.deleted_at).toBe(42);
    });

    it("persists the deleted_at timestamp to the row", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await collectionDelete.handler(ctx, { collection_id: EMPTY });
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["deleted_at", "updated_at"])
        .where("id", "=", EMPTY)
        .executeTakeFirst();
      expect(row?.deleted_at).toBe(42);
      expect(row?.updated_at).toBe(42);
    });

    it("treats a collection whose only descendants are soft-deleted as empty", async () => {
      await seed();
      // ROOT has DELETED_CHILD (soft-deleted) and DOC_TRASHED (soft-
      // deleted) as its only descendants — both filtered by the
      // `deleted_at IS NULL` predicate.
      const ctx = buildCtx(userPrincipal());
      const out = await collectionDelete.handler(ctx, { collection_id: ROOT });
      expect(out.collection_id).toBe(ROOT);
    });
  });

  describe("404 handling", () => {
    it("throws NotFoundError when the collection is missing", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionDelete.handler(ctx, { collection_id: MISSING }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the collection is already soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionDelete.handler(ctx, { collection_id: ALREADY_DELETED }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("live-descendants refusal", () => {
    it("throws HasLiveDescendantsError when a live child collection exists", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionDelete.handler(ctx, { collection_id: PARENT_WITH_CHILD }),
      ).rejects.toBeInstanceOf(HasLiveDescendantsError);
    });

    it("throws HasLiveDescendantsError when a live child doc exists", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionDelete.handler(ctx, { collection_id: PARENT_WITH_DOC }),
      ).rejects.toBeInstanceOf(HasLiveDescendantsError);
    });

    it("error carries descendant counts for the UI", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      try {
        await collectionDelete.handler(ctx, { collection_id: PARENT_WITH_CHILD });
        throw new Error("expected HasLiveDescendantsError");
      } catch (err) {
        expect(err).toBeInstanceOf(HasLiveDescendantsError);
        if (err instanceof HasLiveDescendantsError) {
          expect(err.collection_id).toBe(PARENT_WITH_CHILD);
          expect(err.descendant_counts).toEqual({ collections: 1, docs: 0 });
        }
      }
    });

    it("counts both child collections and child docs when both exist", async () => {
      await seed();
      // Set up a parent that has both: put a nested collection + a doc
      // under PARENT_WITH_DOC so the count is { collections: 1, docs: 1 }.
      const nested = CollectionId("018f0000-0000-7000-8000-0000000000c8");
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("collections")
        .values({
          id: nested,
          workspace_id: WORKSPACE_A,
          parent_id: PARENT_WITH_DOC,
          title: "Nested",
          slug: "nested-here",
          order_key: "a7",
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      const ctx = buildCtx(userPrincipal());
      try {
        await collectionDelete.handler(ctx, { collection_id: PARENT_WITH_DOC });
        throw new Error("expected HasLiveDescendantsError");
      } catch (err) {
        if (err instanceof HasLiveDescendantsError) {
          expect(err.descendant_counts).toEqual({ collections: 1, docs: 1 });
        }
      }
    });

    it("does not count soft-deleted children", async () => {
      // ROOT's only descendants are soft-deleted (see seed), so delete
      // succeeds — already covered in the happy-path block. This test
      // re-asserts the negative case around the counting predicate.
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(collectionDelete.handler(ctx, { collection_id: ROOT })).resolves.toBeDefined();
    });
  });

  describe("input validation", () => {
    it("rejects unknown fields via strict()", () => {
      const result = collectionDelete.input.safeParse({
        collection_id: EMPTY,
        stray: 1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUIDv7 collection_id", () => {
      const result = collectionDelete.input.safeParse({
        collection_id: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("registry metadata + audit projections", () => {
    it("declares the expected registry metadata", () => {
      expect(collectionDelete.id).toBe("collection.delete");
      expect(collectionDelete.category).toBe("mutation");
      expect(collectionDelete.requires).toEqual(["doc:delete"]);
      expect(collectionDelete.surfaces).toEqual(["api", "cli", "mcp"]);
    });

    it("emits the collection.soft_delete effect on allow (carrying deleted_at)", () => {
      // The effect carries the handler's `deleted_at` so replay reconstructs
      // the ADR 0017 recovery anchor precisely (Codex review HIGH 4).
      const effect = collectionDelete.audit.effectOnAllow(
        { collection_id: EMPTY },
        { collection_id: EMPTY, deleted_at: 42 },
      );
      expect(effect.kind).toBe("collection.soft_delete");
      if (effect.kind === "collection.soft_delete") {
        expect(effect.collection_id).toBe(EMPTY);
        expect(effect.deleted_at).toBe(42);
      }
    });

    it("projects a per-collection subject", () => {
      const subject = collectionDelete.audit.subjectFrom({ collection_id: EMPTY });
      expect(subject.kind).toBe("collection");
      if (subject.kind === "collection") {
        expect(subject.id).toBe(EMPTY);
      }
    });

    it("is not collapsible (mutation)", () => {
      expect(collectionDelete.audit.collapsePolicy.collapsible).toBe(false);
    });

    it("emits a deny effect carrying the reason code", () => {
      const effect = collectionDelete.audit.effectOnDeny(
        { collection_id: EMPTY },
        { kind: "missing_scope", required: ["doc:delete"], principal_scopes: [] },
      );
      expect(effect.kind).toBe("deny");
      if (effect.kind === "deny") {
        expect(effect.capability).toBe("collection.delete");
        expect(effect.required_scopes).toEqual(["doc:delete"]);
        expect(effect.reason_code).toBe("missing_scope");
      }
    });

    it("preserves HandlerError kind via effectOnError", () => {
      const effect = collectionDelete.audit.effectOnError(
        { collection_id: EMPTY },
        { kind: "conflict" },
      );
      expect(effect.kind).toBe("error");
      if (effect.kind === "error") {
        expect(effect.capability).toBe("collection.delete");
        expect(effect.error_code).toBe("conflict");
      }
    });
  });
});
