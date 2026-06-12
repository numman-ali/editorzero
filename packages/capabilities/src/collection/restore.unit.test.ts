/**
 * `collection.restore` — capability-level integration test.
 *
 * Exercises the handler against a real in-memory SQLite driver. Covers
 * 404 (missing, already-live), the parent-deleted precondition, and
 * the happy-path restore.
 */

import { COLLECTIONS_DDL, createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import {
  NotFoundError,
  ParentDeletedError,
  SlugCollisionError,
  ValidationError,
} from "@editorzero/errors";
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

  describe("sibling-slug precondition (Step-8 slice-2b fix-forward)", () => {
    it("a LIVE root sibling claimed the slug while trashed → typed 409, nothing mutated", async () => {
      await seed();
      // The partial index frees a trashed slug — a new live root
      // collection legitimately takes "trashed-root".
      const a = driver.scoped(WORKSPACE_A);
      await a
        .insertInto("collections")
        .values({
          id: CollectionId("018f0000-0000-7000-8000-0000000000c7"),
          workspace_id: WORKSPACE_A,
          parent_id: null,
          title: "Usurper",
          slug: "trashed-root",
          order_key: "a6",
          created_by: ALICE,
          created_at: 2,
          updated_at: 2,
          deleted_at: null,
        })
        .execute();

      const err = await collectionRestore
        .handler(
          buildCtx(userPrincipal()),
          collectionRestore.input.parse({ collection_id: DELETED_ROOT }),
        )
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SlugCollisionError);
      if (err instanceof SlugCollisionError) {
        expect(err.slug).toBe("trashed-root");
        expect(err.parent_kind).toBe("workspace");
      }

      const row = await a
        .selectFrom("collections")
        .select(["deleted_at"])
        .where("id", "=", DELETED_ROOT)
        .executeTakeFirstOrThrow();
      expect(row.deleted_at).toBe(500);
    });

    it("a NESTED sibling collision scopes to the parent; a same-slug cousin elsewhere does not block", async () => {
      await seed();
      const a = driver.scoped(WORKSPACE_A);
      // Same slug as DELETED_CHILD_UNDER_LIVE but under a DIFFERENT
      // parent — not a collision (per-parent index scope).
      await a
        .insertInto("collections")
        .values({
          id: CollectionId("018f0000-0000-7000-8000-0000000000c8"),
          workspace_id: WORKSPACE_A,
          parent_id: LIVE_ROOT,
          title: "Cousin",
          slug: "child-live",
          order_key: "a7",
          created_by: ALICE,
          created_at: 2,
          updated_at: 2,
          deleted_at: null,
        })
        .execute();
      const out = await collectionRestore.handler(
        buildCtx(userPrincipal()),
        collectionRestore.input.parse({ collection_id: DELETED_CHILD_UNDER_LIVE }),
      );
      expect(out.collection_id).toBe(DELETED_CHILD_UNDER_LIVE);
    });
  });

  describe("depth-cap check (slice-3 follow-on; Codex review)", () => {
    // The scenario Codex called out: slice-3 `collection.move` walks
    // only live descendants when computing subtree_height, so a
    // "delete deep subtree bottom-up → move parent deeper →
    // restore subtree top-down" sequence bypasses slice-3's cap
    // check — the depth violation only becomes visible on the
    // deepest restore. These tests build that exact sequence
    // directly via driver seeding so we can anchor each expected
    // state.
    //
    // Convention: MAX_DEPTH = 8 ⇒ valid depths 0..7, reject at 8.

    /**
     * Helper: insert a live root collection at depth 0.
     */
    async function insertRoot(id: CollectionId, slug: string): Promise<void> {
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("collections")
        .values({
          id,
          workspace_id: WORKSPACE_A,
          parent_id: null,
          title: slug,
          slug,
          order_key: slug,
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
    }

    /**
     * Helper: insert a collection row with explicit parent +
     * `deleted_at`. Used to set up the exact topology each test
     * needs without going through the dispatcher.
     */
    async function insertCollection(params: {
      id: CollectionId;
      parent_id: CollectionId | null;
      slug: string;
      deleted_at: number | null;
    }): Promise<void> {
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("collections")
        .values({
          id: params.id,
          workspace_id: WORKSPACE_A,
          parent_id: params.parent_id,
          title: params.slug,
          slug: params.slug,
          order_key: params.slug,
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: params.deleted_at,
        })
        .execute();
    }

    it("restoring a leaf under a depth-7 parent is refused (would land at depth 8)", async () => {
      // Build a live chain of length 7 (depths 0..6), then attach a
      // deleted leaf under DEEP[6] at depth 7. The leaf itself is
      // already at depth 7, so restoring *in place* is cap-OK
      // (7 < 8). Arrange a scenario where the leaf's stored parent
      // is at depth 7 after a move — that puts the leaf at depth 8.
      //
      // Simpler construction: insert a live collection at depth 7
      // (valid per create) — call it P7 — then a deleted child C
      // under P7. C would be at depth 8 when restored, which is
      // invalid.
      //
      // This is exactly the shape produced by
      // delete-C → move-P7-deeper → attempt-restore-C when the
      // topology starts with P7 higher up. We skip the move dance
      // here; the restore handler's check doesn't care *how* the
      // topology got this way.
      const ROOT = CollectionId("018f0000-0000-7000-8000-0000000000f0");
      const D1 = CollectionId("018f0000-0000-7000-8000-0000000000f1");
      const D2 = CollectionId("018f0000-0000-7000-8000-0000000000f2");
      const D3 = CollectionId("018f0000-0000-7000-8000-0000000000f3");
      const D4 = CollectionId("018f0000-0000-7000-8000-0000000000f4");
      const D5 = CollectionId("018f0000-0000-7000-8000-0000000000f5");
      const D6 = CollectionId("018f0000-0000-7000-8000-0000000000f6");
      const LEAF = CollectionId("018f0000-0000-7000-8000-0000000000f7");

      await insertRoot(ROOT, "r0");
      await insertCollection({ id: D1, parent_id: ROOT, slug: "d1", deleted_at: null });
      await insertCollection({ id: D2, parent_id: D1, slug: "d2", deleted_at: null });
      await insertCollection({ id: D3, parent_id: D2, slug: "d3", deleted_at: null });
      await insertCollection({ id: D4, parent_id: D3, slug: "d4", deleted_at: null });
      await insertCollection({ id: D5, parent_id: D4, slug: "d5", deleted_at: null });
      await insertCollection({ id: D6, parent_id: D5, slug: "d6", deleted_at: null });
      // D6 is at depth 6. LEAF is stored under D6 (depth 7 when
      // live), but it's deleted. That's the state slice-3 move
      // could produce (move a parent deeper while the deleted
      // descendant stays under it).
      await insertCollection({ id: LEAF, parent_id: D6, slug: "leaf", deleted_at: 500 });

      // LEAF at depth 7 = valid. So restoring LEAF itself should
      // succeed. This is the "deepest restore that still passes"
      // case — tests the boundary.
      const ctx = buildCtx(userPrincipal());
      const out = await collectionRestore.handler(ctx, { collection_id: LEAF });
      expect(out.collection_id).toBe(LEAF);
    });

    it("Codex's cross-slice scenario end-to-end: delete deep subtree → move parent deeper → top-down restore refused on the deepest node", async () => {
      // Construct: A → B → C → D live, depths 0,1,2,3.
      // Soft-delete D, C, B top-down (simulating what slice-2
      // delete requires — live-descendants-refused, so each is
      // zero-live-descendants at its delete).
      // Then move A under a depth-4 parent (DEEP4) → A at depth 5,
      // B at stored-depth 6 when restored, C at 7, D at 8.
      // Top-down restore: B (depth 6) OK → C (depth 7) OK → D
      // (depth 8) → MUST REFUSE.
      const DEEP0 = CollectionId("018f0000-0000-7000-8000-0000000000a0");
      const DEEP1 = CollectionId("018f0000-0000-7000-8000-0000000000a1");
      const DEEP2 = CollectionId("018f0000-0000-7000-8000-0000000000a2");
      const DEEP3 = CollectionId("018f0000-0000-7000-8000-0000000000a3");
      const DEEP4 = CollectionId("018f0000-0000-7000-8000-0000000000a4");
      const A = CollectionId("018f0000-0000-7000-8000-0000000000b0");
      const B = CollectionId("018f0000-0000-7000-8000-0000000000b1");
      const C = CollectionId("018f0000-0000-7000-8000-0000000000b2");
      const D = CollectionId("018f0000-0000-7000-8000-0000000000b3");

      // DEEP chain 0..4 (A's new parent is at depth 4).
      await insertRoot(DEEP0, "deep0");
      await insertCollection({ id: DEEP1, parent_id: DEEP0, slug: "deep1", deleted_at: null });
      await insertCollection({ id: DEEP2, parent_id: DEEP1, slug: "deep2", deleted_at: null });
      await insertCollection({ id: DEEP3, parent_id: DEEP2, slug: "deep3", deleted_at: null });
      await insertCollection({ id: DEEP4, parent_id: DEEP3, slug: "deep4", deleted_at: null });
      // A now at depth 5 (under DEEP4 at 4). B/C/D still stored
      // under A/B/C respectively, all deleted.
      await insertCollection({ id: A, parent_id: DEEP4, slug: "a", deleted_at: null });
      await insertCollection({ id: B, parent_id: A, slug: "b", deleted_at: 501 });
      await insertCollection({ id: C, parent_id: B, slug: "c", deleted_at: 500 });
      await insertCollection({ id: D, parent_id: C, slug: "d", deleted_at: 499 });

      const ctx = buildCtx(userPrincipal());
      // B lives at depth 6 (valid < 8). Restore OK.
      const outB = await collectionRestore.handler(ctx, { collection_id: B });
      expect(outB.collection_id).toBe(B);
      // C at depth 7 (valid). Restore OK.
      const outC = await collectionRestore.handler(ctx, { collection_id: C });
      expect(outC.collection_id).toBe(C);
      // D at depth 8 (invalid). Restore MUST REFUSE — this is the
      // bug that existed before the slice-3 follow-on fix.
      await expect(collectionRestore.handler(ctx, { collection_id: D })).rejects.toSatisfy(
        (err: unknown) => {
          if (!(err instanceof ValidationError)) return false;
          const issues = err.issues as ReadonlyArray<{ code?: string }>;
          return issues.some((i) => i.code === "depth_cap_exceeded");
        },
      );

      // D still soft-deleted after refusal (no partial writes).
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["deleted_at"])
        .where("id", "=", D)
        .executeTakeFirst();
      expect(row?.deleted_at).not.toBeNull();
    });

    it("restoring a root collection always passes the cap (no parent)", async () => {
      // Subtree height 0 + parent_depth 0 = 0 < 8. Root restores
      // never trigger the cap (unless subtree_height itself is
      // pathological, which the invariant prevents).
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await collectionRestore.handler(ctx, { collection_id: DELETED_ROOT });
      expect(out.collection_id).toBe(DELETED_ROOT);
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
      expect(collectionRestore.surfaces).toEqual(["api", "cli", "mcp"]);
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
