/**
 * `collection.update` — capability-level integration test.
 *
 * Exercises the handler against a real in-memory SQLite driver so the
 * UPDATE + slug pre-check SELECT actually run. Covers 404, slug-
 * collision, no-op rename (same slug), and the happy path.
 */

import { COLLECTIONS_DDL, createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError, SlugCollisionError } from "@editorzero/errors";
import { CollectionId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { collectionUpdate } from "./update";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const ROOT = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const SIBLING = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const NESTED = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const NESTED_SIBLING = CollectionId("018f0000-0000-7000-8000-0000000000c4");
const DELETED = CollectionId("018f0000-0000-7000-8000-0000000000c5");
const MISSING = CollectionId("018f0000-0000-7000-8000-0000000000c9");

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
      throw new Error("collection.update must not call ctx.transact (metadata-only capability)");
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
        id: SIBLING,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Sibling",
        slug: "sibling",
        order_key: "a1",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: NESTED,
        workspace_id: WORKSPACE_A,
        parent_id: ROOT,
        title: "Nested",
        slug: "nested",
        order_key: "a2",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: NESTED_SIBLING,
        workspace_id: WORKSPACE_A,
        parent_id: ROOT,
        title: "Other",
        slug: "other",
        order_key: "a3",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: DELETED,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Deleted",
        slug: "deleted",
        order_key: "a4",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 999,
      },
    ])
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("collection.update", () => {
  describe("happy path", () => {
    it("renames a collection and derives a fresh slug", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await collectionUpdate.handler(ctx, {
        collection_id: ROOT,
        title: "New Title",
      });
      expect(out.collection_id).toBe(ROOT);
      expect(out.title).toBe("New Title");
      expect(out.slug).toBe("new-title");
      expect(out.updated_at).toBe(42);
    });

    it("persists the title+slug change to the row", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await collectionUpdate.handler(ctx, { collection_id: ROOT, title: "Renamed" });
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["title", "slug", "updated_at"])
        .where("id", "=", ROOT)
        .executeTakeFirst();
      expect(row).toEqual({ title: "Renamed", slug: "renamed", updated_at: 42 });
    });

    it("allows a no-op rename (same title → same slug, no collision with self)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await collectionUpdate.handler(ctx, {
        collection_id: ROOT,
        title: "Root",
      });
      expect(out.slug).toBe("root");
    });

    it("falls back to 'untitled' when title slugifies to empty", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await collectionUpdate.handler(ctx, {
        collection_id: ROOT,
        title: "!!!",
      });
      expect(out.slug).toBe("untitled");
    });

    it("trims surrounding whitespace from the title at the schema layer", () => {
      // The `.trim()` lives on the zod schema, not the handler — tests
      // that hit `handler` directly bypass it. This schema-level assertion
      // is what `doc.rename` / `doc.create` cover the same way.
      const result = collectionUpdate.input.safeParse({
        collection_id: ROOT,
        title: "  Spaced  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Spaced");
      }
    });
  });

  describe("404 handling", () => {
    it("throws NotFoundError when the collection is missing", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionUpdate.handler(ctx, { collection_id: MISSING, title: "X" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the collection is soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionUpdate.handler(ctx, { collection_id: DELETED, title: "X" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("slug collision", () => {
    it("throws SlugCollisionError when a root sibling already has the derived slug", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionUpdate.handler(ctx, { collection_id: ROOT, title: "Sibling" }),
      ).rejects.toBeInstanceOf(SlugCollisionError);
    });

    it("throws SlugCollisionError when a nested sibling already has the derived slug", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionUpdate.handler(ctx, { collection_id: NESTED, title: "Other" }),
      ).rejects.toBeInstanceOf(SlugCollisionError);
    });

    it("error carries the derived slug + sibling scope", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      try {
        await collectionUpdate.handler(ctx, { collection_id: ROOT, title: "Sibling" });
        throw new Error("expected SlugCollisionError");
      } catch (err) {
        expect(err).toBeInstanceOf(SlugCollisionError);
        if (err instanceof SlugCollisionError) {
          expect(err.slug).toBe("sibling");
          expect(err.parent_kind).toBe("workspace");
          expect(err.parent_id).toBeNull();
        }
      }
    });

    it("ignores soft-deleted siblings when checking collision (different slug available)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      // DELETED holds slug "deleted" but is soft-deleted, so another root
      // collection can take "deleted" without collision.
      const out = await collectionUpdate.handler(ctx, {
        collection_id: ROOT,
        title: "Deleted",
      });
      expect(out.slug).toBe("deleted");
    });
  });

  describe("input validation", () => {
    it("rejects empty title", () => {
      const result = collectionUpdate.input.safeParse({
        collection_id: ROOT,
        title: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects whitespace-only title after trim", () => {
      const result = collectionUpdate.input.safeParse({
        collection_id: ROOT,
        title: "   ",
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown input fields via strict()", () => {
      const result = collectionUpdate.input.safeParse({
        collection_id: ROOT,
        title: "X",
        stray: 1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUIDv7 collection_id", () => {
      const result = collectionUpdate.input.safeParse({
        collection_id: "not-a-uuid",
        title: "X",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("registry metadata + audit projections", () => {
    it("declares the expected registry metadata", () => {
      expect(collectionUpdate.id).toBe("collection.update");
      expect(collectionUpdate.category).toBe("mutation");
      expect(collectionUpdate.requires).toEqual(["doc:write"]);
      expect(collectionUpdate.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    });

    it("emits the collection.update effect on allow with a patch carrying title+slug", () => {
      const effect = collectionUpdate.audit.effectOnAllow(
        { collection_id: ROOT, title: "X" },
        { collection_id: ROOT, title: "X", slug: "x", updated_at: 1 },
      );
      expect(effect.kind).toBe("collection.update");
      if (effect.kind === "collection.update") {
        expect(effect.collection_id).toBe(ROOT);
        expect(effect.patch).toEqual({ title: "X", slug: "x" });
      }
    });

    it("projects a per-collection subject", () => {
      const subject = collectionUpdate.audit.subjectFrom({ collection_id: ROOT, title: "X" });
      expect(subject.kind).toBe("collection");
      if (subject.kind === "collection") {
        expect(subject.id).toBe(ROOT);
      }
    });

    it("emits a deny effect carrying the reason code when the gate denies", () => {
      const effect = collectionUpdate.audit.effectOnDeny(
        { collection_id: ROOT, title: "X" },
        { kind: "missing_scope", required: ["doc:write"], principal_scopes: [] },
      );
      expect(effect.kind).toBe("deny");
      if (effect.kind === "deny") {
        expect(effect.capability).toBe("collection.update");
        expect(effect.required_scopes).toEqual(["doc:write"]);
      }
    });

    it("is not collapsible (mutation)", () => {
      expect(collectionUpdate.audit.collapsePolicy.collapsible).toBe(false);
    });

    it("preserves HandlerError kind via effectOnError", () => {
      const effect = collectionUpdate.audit.effectOnError(
        { collection_id: ROOT, title: "X" },
        { kind: "conflict" },
      );
      expect(effect.kind).toBe("error");
      if (effect.kind === "error") {
        expect(effect.capability).toBe("collection.update");
        expect(effect.error_code).toBe("conflict");
      }
    });
  });
});
