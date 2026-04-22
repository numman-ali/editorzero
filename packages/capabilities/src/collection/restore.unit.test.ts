/**
 * `collection.restore` — capability-level integration test.
 *
 * Exercises the handler against a real in-memory SQLite driver. Covers
 * 404 (missing, already-live), the parent-deleted precondition, and
 * the happy-path restore.
 */

import { COLLECTIONS_DDL, createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError, ParentDeletedError } from "@editorzero/errors";
import { CollectionId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { collectionRestore } from "./restore";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const DELETED_ROOT = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const LIVE_ROOT = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const DELETED_PARENT = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const LIVE_PARENT = CollectionId("018f0000-0000-7000-8000-0000000000c4");
const DELETED_CHILD_UNDER_LIVE = CollectionId("018f0000-0000-7000-8000-0000000000c5");
const DELETED_CHILD_UNDER_DELETED = CollectionId("018f0000-0000-7000-8000-0000000000c6");
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
      throw new Error("collection.restore must not call ctx.transact (metadata-only capability)");
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
        id: DELETED_ROOT,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Trashed Root",
        slug: "trashed-root",
        order_key: "a0",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 500,
      },
      {
        id: LIVE_ROOT,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Live Root",
        slug: "live-root",
        order_key: "a1",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: LIVE_PARENT,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Live Parent",
        slug: "live-parent",
        order_key: "a2",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: DELETED_PARENT,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "Dead Parent",
        slug: "dead-parent",
        order_key: "a3",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 500,
      },
      {
        id: DELETED_CHILD_UNDER_LIVE,
        workspace_id: WORKSPACE_A,
        parent_id: LIVE_PARENT,
        title: "Child under live",
        slug: "child-live",
        order_key: "a4",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 500,
      },
      {
        id: DELETED_CHILD_UNDER_DELETED,
        workspace_id: WORKSPACE_A,
        parent_id: DELETED_PARENT,
        title: "Child under dead",
        slug: "child-dead",
        order_key: "a5",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 500,
      },
    ])
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("collection.restore", () => {
  describe("happy path", () => {
    it("restores a soft-deleted root collection", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await collectionRestore.handler(ctx, { collection_id: DELETED_ROOT });
      expect(out.collection_id).toBe(DELETED_ROOT);
    });

    it("clears deleted_at on the row and bumps updated_at", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await collectionRestore.handler(ctx, { collection_id: DELETED_ROOT });
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["deleted_at", "updated_at"])
        .where("id", "=", DELETED_ROOT)
        .executeTakeFirst();
      expect(row?.deleted_at).toBeNull();
      expect(row?.updated_at).toBe(42);
    });

    it("restores a nested child whose parent is live", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await collectionRestore.handler(ctx, {
        collection_id: DELETED_CHILD_UNDER_LIVE,
      });
      expect(out.collection_id).toBe(DELETED_CHILD_UNDER_LIVE);
    });
  });

  describe("404 handling", () => {
    it("throws NotFoundError when the collection is missing", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionRestore.handler(ctx, { collection_id: MISSING }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the collection is already live", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionRestore.handler(ctx, { collection_id: LIVE_ROOT }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("parent-deleted precondition", () => {
    it("throws ParentDeletedError when the parent is soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionRestore.handler(ctx, { collection_id: DELETED_CHILD_UNDER_DELETED }),
      ).rejects.toBeInstanceOf(ParentDeletedError);
    });

    it("error carries the soft-deleted parent id + kind", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      try {
        await collectionRestore.handler(ctx, {
          collection_id: DELETED_CHILD_UNDER_DELETED,
        });
        throw new Error("expected ParentDeletedError");
      } catch (err) {
        expect(err).toBeInstanceOf(ParentDeletedError);
        if (err instanceof ParentDeletedError) {
          expect(err.parent_kind).toBe("collection");
          expect(err.parent_id).toBe(DELETED_PARENT);
        }
      }
    });

    it("still leaves the child soft-deleted after refusal (no partial writes)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionRestore.handler(ctx, { collection_id: DELETED_CHILD_UNDER_DELETED }),
      ).rejects.toBeInstanceOf(ParentDeletedError);
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["deleted_at"])
        .where("id", "=", DELETED_CHILD_UNDER_DELETED)
        .executeTakeFirst();
      expect(row?.deleted_at).not.toBeNull();
    });
  });

  describe("input validation", () => {
    it("rejects unknown fields via strict()", () => {
      const result = collectionRestore.input.safeParse({
        collection_id: DELETED_ROOT,
        stray: 1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUIDv7 collection_id", () => {
      const result = collectionRestore.input.safeParse({
        collection_id: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("registry metadata + audit projections", () => {
    it("declares the expected registry metadata", () => {
      expect(collectionRestore.id).toBe("collection.restore");
      expect(collectionRestore.category).toBe("mutation");
      expect(collectionRestore.requires).toEqual(["doc:delete"]);
      expect(collectionRestore.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    });

    it("emits the collection.restore effect on allow", () => {
      const effect = collectionRestore.audit.effectOnAllow(
        { collection_id: DELETED_ROOT },
        { collection_id: DELETED_ROOT },
      );
      expect(effect.kind).toBe("collection.restore");
      if (effect.kind === "collection.restore") {
        expect(effect.collection_id).toBe(DELETED_ROOT);
      }
    });

    it("is not collapsible (mutation)", () => {
      expect(collectionRestore.audit.collapsePolicy.collapsible).toBe(false);
    });

    it("projects a per-collection subject", () => {
      const subject = collectionRestore.audit.subjectFrom({ collection_id: DELETED_ROOT });
      expect(subject.kind).toBe("collection");
      if (subject.kind === "collection") {
        expect(subject.id).toBe(DELETED_ROOT);
      }
    });

    it("emits a deny effect carrying the reason code", () => {
      const effect = collectionRestore.audit.effectOnDeny(
        { collection_id: DELETED_ROOT },
        { kind: "missing_scope", required: ["doc:delete"], principal_scopes: [] },
      );
      expect(effect.kind).toBe("deny");
      if (effect.kind === "deny") {
        expect(effect.capability).toBe("collection.restore");
      }
    });

    it("preserves HandlerError kind via effectOnError", () => {
      const effect = collectionRestore.audit.effectOnError(
        { collection_id: DELETED_ROOT },
        { kind: "conflict" },
      );
      expect(effect.kind).toBe("error");
      if (effect.kind === "error") {
        expect(effect.capability).toBe("collection.restore");
        expect(effect.error_code).toBe("conflict");
      }
    });
  });
});
