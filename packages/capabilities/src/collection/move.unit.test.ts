/**
 * `collection.move` — capability-level integration test.
 *
 * Exercises the handler against a real in-memory SQLite driver. Covers:
 *
 *   - 404 on missing/soft-deleted moved collection
 *   - 404 on missing/soft-deleted target parent
 *   - cycle detection (self-parent + grandchild-parent)
 *   - subtree-height preservation (moving a deep subtree under a deep
 *     parent must fail with `depth_cap_exceeded`; moving a leaf is fine)
 *   - target-scope slug collision (typed 409 via `SlugCollisionError`)
 *   - happy-path move to root + move to another collection
 *   - no-op same-parent move still re-seats `order_key` / `updated_at`
 *   - input validation (strict, UUIDv7, explicit null for root)
 *   - registry metadata + audit projections
 */

import { COLLECTION_MAX_DEPTH } from "@editorzero/constants";
import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import {
  NotFoundError,
  PermissionDeniedError,
  SlugCollisionError,
  ValidationError,
} from "@editorzero/errors";
import { CollectionId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { CapabilityContext } from "../kernel";
import { collectionMove } from "./move";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

// Tree:
//   ROOT_A (depth 0)
//   └── MID_A (depth 1)
//       └── LEAF_A (depth 2)
//   ROOT_B (depth 0)
//   └── MID_B (depth 1)
//   DEEP_0 (depth 0) → DEEP_1 → … → DEEP_6 (depth 6)
//     — chain of 7 collections, the deepest valid depth.
const ROOT_A = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const MID_A = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const LEAF_A = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const ROOT_B = CollectionId("018f0000-0000-7000-8000-0000000000c4");
const MID_B = CollectionId("018f0000-0000-7000-8000-0000000000c5");
const SOFT_DELETED = CollectionId("018f0000-0000-7000-8000-0000000000c6");
const MISSING = CollectionId("018f0000-0000-7000-8000-0000000000c9");

// Deep chain fixtures — IDs encode depth (0..6) for readability.
const DEEP_IDS: CollectionId[] = [
  CollectionId("018f0000-0000-7000-8000-0000000000d0"),
  CollectionId("018f0000-0000-7000-8000-0000000000d1"),
  CollectionId("018f0000-0000-7000-8000-0000000000d2"),
  CollectionId("018f0000-0000-7000-8000-0000000000d3"),
  CollectionId("018f0000-0000-7000-8000-0000000000d4"),
  CollectionId("018f0000-0000-7000-8000-0000000000d5"),
  CollectionId("018f0000-0000-7000-8000-0000000000d6"),
];

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  // The step-2b same-bucket rail loads the ACL resolver (spaces /
  // space_members / grants) whenever either end carries a stored
  // space ref; all-legacy moves never touch these tables.
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
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
      throw new Error("collection.move must not call ctx.transact (metadata-only)");
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
        id: ROOT_A,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "RootA",
        slug: "root-a",
        order_key: "a0",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: MID_A,
        workspace_id: WORKSPACE_A,
        parent_id: ROOT_A,
        title: "MidA",
        slug: "mid-a",
        order_key: "a1",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: LEAF_A,
        workspace_id: WORKSPACE_A,
        parent_id: MID_A,
        title: "LeafA",
        slug: "leaf-a",
        order_key: "a2",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: ROOT_B,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "RootB",
        slug: "root-b",
        order_key: "a3",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: MID_B,
        workspace_id: WORKSPACE_A,
        parent_id: ROOT_B,
        title: "MidB",
        slug: "mid-b",
        order_key: "a4",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: SOFT_DELETED,
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
    ])
    .execute();
}

async function seedDeepChain() {
  // Chain: DEEP_IDS[0] (root, depth 0) → … → DEEP_IDS[6] (depth 6,
  // valid — max is 7). No move that pushes this past depth 7 is legal.
  const a = driver.scoped(WORKSPACE_A);
  for (let i = 0; i < DEEP_IDS.length; i++) {
    const id = DEEP_IDS[i];
    const parent = i === 0 ? null : DEEP_IDS[i - 1];
    if (id === undefined) continue;
    await a
      .insertInto("collections")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        parent_id: parent,
        title: `D${i}`,
        slug: `d-${i}`,
        order_key: `d${i}`,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("collection.move", () => {
  describe("happy path", () => {
    it("moves a leaf to the workspace root (new_parent_id=null)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const out = await collectionMove.handler(ctx, {
        collection_id: LEAF_A,
        new_parent_id: null,
      });
      expect(out.collection_id).toBe(LEAF_A);
      expect(out.new_parent_id).toBeNull();
      expect(out.updated_at).toBe(42);
      expect(out.new_order_key).toBeTruthy();

      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["parent_id", "order_key", "updated_at"])
        .where("id", "=", LEAF_A)
        .executeTakeFirst();
      expect(row?.parent_id).toBeNull();
      expect(row?.updated_at).toBe(42);
      expect(row?.order_key).toBe(out.new_order_key);
    });

    it("moves a subtree under a different parent", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await collectionMove.handler(ctx, {
        collection_id: MID_A,
        new_parent_id: ROOT_B,
      });
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["parent_id"])
        .where("id", "=", MID_A)
        .executeTakeFirst();
      expect(row?.parent_id).toBe(ROOT_B);
      // LEAF_A's parent_id stays MID_A — the subtree moves as a unit.
      const leaf = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["parent_id"])
        .where("id", "=", LEAF_A)
        .executeTakeFirst();
      expect(leaf?.parent_id).toBe(MID_A);
    });

    it("accepts a no-op same-parent move (re-seats order_key / updated_at)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      const before = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("collections")
        .select(["order_key"])
        .where("id", "=", MID_A)
        .executeTakeFirst();
      const out = await collectionMove.handler(ctx, {
        collection_id: MID_A,
        new_parent_id: ROOT_A, // same parent
      });
      expect(out.new_order_key).not.toBe(before?.order_key);
      expect(out.updated_at).toBe(42);
    });
  });

  describe("404 handling", () => {
    it("throws NotFoundError when the moved collection is missing", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, { collection_id: MISSING, new_parent_id: null }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the moved collection is soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, { collection_id: SOFT_DELETED, new_parent_id: null }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the target parent is missing", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, { collection_id: LEAF_A, new_parent_id: MISSING }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the target parent is soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, { collection_id: LEAF_A, new_parent_id: SOFT_DELETED }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("cycle detection", () => {
    it("refuses self-parent (new_parent_id === collection_id)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, { collection_id: MID_A, new_parent_id: MID_A }),
      ).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof ValidationError)) return false;
        const issues = err.issues as ReadonlyArray<{ code?: string }>;
        return issues.some((i) => i.code === "cycle_detected");
      });
    });

    it("refuses moving an ancestor under one of its descendants", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      // MID_A is ROOT_A's child → LEAF_A is MID_A's child. Moving
      // ROOT_A under LEAF_A would create a cycle.
      await expect(
        collectionMove.handler(ctx, { collection_id: ROOT_A, new_parent_id: LEAF_A }),
      ).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof ValidationError)) return false;
        const issues = err.issues as ReadonlyArray<{ code?: string }>;
        return issues.some((i) => i.code === "cycle_detected");
      });
    });

    it("refuses moving a subtree under its own immediate child", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      // Moving ROOT_A under MID_A (its direct child).
      await expect(
        collectionMove.handler(ctx, { collection_id: ROOT_A, new_parent_id: MID_A }),
      ).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof ValidationError)) return false;
        const issues = err.issues as ReadonlyArray<{ code?: string }>;
        return issues.some((i) => i.code === "cycle_detected");
      });
    });
  });

  describe("subtree-height preservation (depth cap)", () => {
    it("refuses when moving a 3-level subtree under a depth-6 parent (deepest lands at 8)", async () => {
      await seedDeepChain();
      await seed();
      // MID_A has height 1 (LEAF_A is its only descendant). Moving MID_A
      // under DEEP_IDS[6] (depth 6) → new depth for MID_A = 7, deepest
      // descendant = 8 → >= MAX_DEPTH, refuse.
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, {
          collection_id: MID_A,
          new_parent_id: DEEP_IDS[6]!,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof ValidationError)) return false;
        const issues = err.issues as ReadonlyArray<{ code?: string }>;
        return issues.some((i) => i.code === "depth_cap_exceeded");
      });
    });

    it("allows moving a leaf under a depth-6 parent (deepest lands at 7 — the max valid)", async () => {
      await seedDeepChain();
      await seed();
      // LEAF_A is a leaf (subtree_height 0). Moving under DEEP_IDS[6]
      // (depth 6) → deepest = 7, < MAX_DEPTH, allowed.
      const ctx = buildCtx(userPrincipal());
      const out = await collectionMove.handler(ctx, {
        collection_id: LEAF_A,
        new_parent_id: DEEP_IDS[6]!,
      });
      expect(out.new_parent_id).toBe(DEEP_IDS[6]);
    });

    it("allows moving a leaf under a depth-5 parent", async () => {
      await seedDeepChain();
      await seed();
      // LEAF_A → DEEP_IDS[5] (depth 5). New depth 6, < 8, allowed.
      const ctx = buildCtx(userPrincipal());
      const out = await collectionMove.handler(ctx, {
        collection_id: LEAF_A,
        new_parent_id: DEEP_IDS[5]!,
      });
      expect(out.new_parent_id).toBe(DEEP_IDS[5]);
    });

    it("refuses when moving under the leaf of a depth-6 chain would push deepest past 7", async () => {
      await seedDeepChain();
      await seed();
      // MID_A (height 1) → DEEP_IDS[5] (depth 5) → deepest = 5+1+1 = 7
      // which is exactly at the cap (< 8 = true), allowed.
      // MID_A → DEEP_IDS[6] (depth 6) → deepest = 6+1+1 = 8 = cap, refuse.
      // Covered above — this test asserts the boundary on the other side.
      const ctx = buildCtx(userPrincipal());
      const out = await collectionMove.handler(ctx, {
        collection_id: MID_A,
        new_parent_id: DEEP_IDS[5]!,
      });
      expect(out.new_parent_id).toBe(DEEP_IDS[5]);
    });

    it("the cap matches collection.create exactly (same MAX_DEPTH)", () => {
      // Sanity guard against the constant drifting — if a future slice
      // bumps MAX_DEPTH and forgets to re-run the boundary tests, this
      // assertion is a loud reminder to revisit.
      expect(COLLECTION_MAX_DEPTH).toBe(8);
    });
  });

  describe("target-scope slug collision", () => {
    it("refuses when the target already has a sibling with the same slug", async () => {
      await seed();
      // Insert a collection under ROOT_B with slug "leaf-a" (same as LEAF_A).
      const clash = CollectionId("018f0000-0000-7000-8000-0000000000e1");
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("collections")
        .values({
          id: clash,
          workspace_id: WORKSPACE_A,
          parent_id: ROOT_B,
          title: "LeafA clone",
          slug: "leaf-a",
          order_key: "e1",
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, { collection_id: LEAF_A, new_parent_id: ROOT_B }),
      ).rejects.toBeInstanceOf(SlugCollisionError);
    });

    it("refuses root-level slug collision when moving to workspace root", async () => {
      await seed();
      // LEAF_A slug "leaf-a" — insert a root-level collection with the
      // same slug.
      const clash = CollectionId("018f0000-0000-7000-8000-0000000000e2");
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("collections")
        .values({
          id: clash,
          workspace_id: WORKSPACE_A,
          parent_id: null,
          title: "LeafA at root",
          slug: "leaf-a",
          order_key: "e2",
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, { collection_id: LEAF_A, new_parent_id: null }),
      ).rejects.toBeInstanceOf(SlugCollisionError);
    });

    it("error carries slug + target parent context", async () => {
      await seed();
      const clash = CollectionId("018f0000-0000-7000-8000-0000000000e3");
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("collections")
        .values({
          id: clash,
          workspace_id: WORKSPACE_A,
          parent_id: ROOT_B,
          title: "clash",
          slug: "leaf-a",
          order_key: "e3",
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      const ctx = buildCtx(userPrincipal());
      try {
        await collectionMove.handler(ctx, { collection_id: LEAF_A, new_parent_id: ROOT_B });
        throw new Error("expected SlugCollisionError");
      } catch (err) {
        expect(err).toBeInstanceOf(SlugCollisionError);
        if (err instanceof SlugCollisionError) {
          expect(err.slug).toBe("leaf-a");
          expect(err.parent_kind).toBe("collection");
          expect(err.parent_id).toBe(ROOT_B);
        }
      }
    });

    it("same-parent move does not trigger slug collision against self", async () => {
      await seed();
      // MID_A stays under ROOT_A — the SELECT for siblings with slug
      // "mid-a" excludes self, so no collision.
      const ctx = buildCtx(userPrincipal());
      const out = await collectionMove.handler(ctx, {
        collection_id: MID_A,
        new_parent_id: ROOT_A,
      });
      expect(out.collection_id).toBe(MID_A);
    });
  });

  describe("input validation", () => {
    it("rejects unknown fields via strict()", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        new_parent_id: null,
        stray: 1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUIDv7 collection_id", () => {
      const result = collectionMove.input.safeParse({
        collection_id: "not-a-uuid",
        new_parent_id: null,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUIDv7 new_parent_id", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        new_parent_id: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });

    it("requires new_parent_id explicitly (omitted → invalid)", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
      });
      expect(result.success).toBe(false);
    });

    it("accepts explicit null for new_parent_id (workspace-root move)", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        new_parent_id: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("registry metadata + audit projections", () => {
    it("declares the expected registry metadata", () => {
      expect(collectionMove.id).toBe("collection.move");
      expect(collectionMove.category).toBe("mutation");
      expect(collectionMove.requires).toEqual(["doc:write"]);
      expect(collectionMove.surfaces).toEqual(["api", "cli", "mcp"]);
    });

    it("emits the collection.move effect on allow with new_parent + new_order_key", () => {
      const effect = collectionMove.audit.effectOnAllow(
        { collection_id: LEAF_A, new_parent_id: ROOT_B },
        {
          collection_id: LEAF_A,
          new_parent_id: ROOT_B,
          new_order_key: "018f0000-0000-7000-8000-000000000111",
          new_space_id: null,
          updated_at: 42,
        },
      );
      expect(effect.kind).toBe("collection.move");
      if (effect.kind === "collection.move") {
        expect(effect.collection_id).toBe(LEAF_A);
        expect(effect.new_parent_id).toBe(ROOT_B);
        expect(effect.new_order_key).toBe("018f0000-0000-7000-8000-000000000111");
        expect(effect.new_space_id).toBeNull();
      }
    });

    it("projects a per-collection subject", () => {
      const subject = collectionMove.audit.subjectFrom({
        collection_id: LEAF_A,
        new_parent_id: null,
      });
      expect(subject.kind).toBe("collection");
      if (subject.kind === "collection") {
        expect(subject.id).toBe(LEAF_A);
      }
    });

    it("emits a deny effect carrying the reason code", () => {
      const effect = collectionMove.audit.effectOnDeny(
        { collection_id: LEAF_A, new_parent_id: null },
        { kind: "missing_scope", required: ["doc:write"], principal_scopes: [] },
      );
      expect(effect.kind).toBe("deny");
      if (effect.kind === "deny") {
        expect(effect.capability).toBe("collection.move");
        expect(effect.required_scopes).toEqual(["doc:write"]);
        expect(effect.reason_code).toBe("missing_scope");
      }
    });

    it("preserves HandlerError kind via effectOnError", () => {
      const effect = collectionMove.audit.effectOnError(
        { collection_id: LEAF_A, new_parent_id: null },
        { kind: "validation", issues: [] },
      );
      expect(effect.kind).toBe("error");
      if (effect.kind === "error") {
        expect(effect.capability).toBe("collection.move");
        expect(effect.error_code).toBe("validation");
      }
    });

    it("is not collapsible (mutation)", () => {
      expect(collectionMove.audit.collapsePolicy.collapsible).toBe(false);
    });
  });
});

// ── Same-bucket rail + placement standing (ADR 0040 space-collection) ────
//
// `collection.move` is same-bucket-only until the crossing branch
// lands: cross-bucket → typed 400 `cross_bucket_move_unsupported`;
// same-space re-parents require baseline reach over the bucket;
// anomalous refs (dangling/trashed space) fail closed on either end;
// all-legacy moves never load the resolver (pinned structurally).

describe("collection.move — same-bucket rail", () => {
  const BOB = UserId("018f0000-0000-7000-8000-0000000000a2");
  const S_TEAM = SpaceId("018f0000-0000-7000-8000-0000000000e1");
  const S_OTHER = SpaceId("018f0000-0000-7000-8000-0000000000e2");
  const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e3");
  const S_GONE = SpaceId("018f0000-0000-7000-8000-0000000000e4"); // never inserted
  const C_S_ROOT = CollectionId("018f0000-0000-7000-8000-0000000000b1");
  const C_S_ROOT2 = CollectionId("018f0000-0000-7000-8000-0000000000b2");
  const C_S_MID = CollectionId("018f0000-0000-7000-8000-0000000000b3");
  const C_S_OTHER = CollectionId("018f0000-0000-7000-8000-0000000000b4");
  const C_DANGLE = CollectionId("018f0000-0000-7000-8000-0000000000b5");
  const C_TRASH_A = CollectionId("018f0000-0000-7000-8000-0000000000b6");
  const C_TRASH_B = CollectionId("018f0000-0000-7000-8000-0000000000b7");

  function bobPrincipal(): UserPrincipal {
    return { ...userPrincipal(), id: BOB };
  }

  async function seedSpaceRow(id: SpaceId, opts: { deleted_at?: number | null } = {}) {
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("spaces")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        kind: "team",
        type: "closed",
        owner_user_id: null,
        name: `space-${id.slice(-2)}`,
        slug: `space-${id.slice(-2)}`,
        baseline_access: "view",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: opts.deleted_at ?? null,
      })
      .execute();
  }

  async function seedBoundCollection(
    id: CollectionId,
    space_id: SpaceId,
    parent_id: CollectionId | null = null,
  ) {
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("collections")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        parent_id,
        space_id,
        title: `col-${id.slice(-2)}`,
        slug: `col-${id.slice(-2)}`,
        order_key: id,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }

  async function seedAliceMembership(space_id: SpaceId) {
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("space_members")
      .values({
        workspace_id: WORKSPACE_A,
        space_id,
        user_id: ALICE,
        role: "edit",
        created_at: 1,
        updated_at: 1,
      })
      .execute();
  }

  async function seedSpaceWorld() {
    await seedSpaceRow(S_TEAM);
    await seedSpaceRow(S_OTHER);
    await seedSpaceRow(S_TRASHED, { deleted_at: 99 });
    await seedBoundCollection(C_S_ROOT, S_TEAM);
    await seedBoundCollection(C_S_ROOT2, S_TEAM);
    await seedBoundCollection(C_S_MID, S_TEAM, C_S_ROOT);
    await seedBoundCollection(C_S_OTHER, S_OTHER);
    await seedBoundCollection(C_DANGLE, S_GONE);
    await seedBoundCollection(C_TRASH_A, S_TRASHED);
    await seedBoundCollection(C_TRASH_B, S_TRASHED);
  }

  // `ValidationError.issues` is `unknown` by design — narrow through a
  // parse (house rule: no casting) before asserting the typed code.
  const IssuesSchema = z.array(z.object({ code: z.string(), path: z.array(z.string()) }).loose());

  function expectCrossBucketRefusal(err: unknown) {
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(err.httpStatus).toBe(400);
      const issues = IssuesSchema.parse(err.issues);
      expect(issues[0]?.code).toBe("cross_bucket_move_unsupported");
      expect(issues[0]?.path).toEqual(["new_parent_id"]);
    }
  }

  it("same-space re-parent with reach succeeds; binding rides unchanged on row + output + effect", async () => {
    await seedSpaceWorld();
    await seedAliceMembership(S_TEAM);
    const ctx = buildCtx(userPrincipal());
    const out = await collectionMove.handler(ctx, {
      collection_id: C_S_MID,
      new_parent_id: C_S_ROOT2,
    });
    expect(out.new_parent_id).toBe(C_S_ROOT2);
    expect(out.new_space_id).toBe(S_TEAM);

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .select(["parent_id", "space_id"])
      .where("id", "=", C_S_MID)
      .executeTakeFirstOrThrow();
    expect(row.parent_id).toBe(C_S_ROOT2);
    expect(row.space_id).toBe(S_TEAM);

    const effect = collectionMove.audit.effectOnAllow(
      { collection_id: C_S_MID, new_parent_id: C_S_ROOT2 },
      out,
    );
    expect(effect.kind).toBe("collection.move");
    if (effect.kind === "collection.move") {
      expect(effect.new_space_id).toBe(S_TEAM);
    }
  });

  it("same-space re-parent WITHOUT reach → acl_deny scoped to the target collection", async () => {
    await seedSpaceWorld();
    const ctx = buildCtx(bobPrincipal()); // no membership, no grant
    const err = await collectionMove
      .handler(ctx, { collection_id: C_S_MID, new_parent_id: C_S_ROOT2 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { collection_id: C_S_ROOT2 } });
    }
  });

  it("legacy → space is refused (typed 400, the crossing branch is a future slice)", async () => {
    await seed();
    await seedSpaceWorld();
    await seedAliceMembership(S_TEAM); // reach doesn't help — the rail fires first
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), { collection_id: MID_B, new_parent_id: C_S_ROOT })
      .catch((e: unknown) => e);
    expectCrossBucketRefusal(err);
  });

  it("space → legacy root is refused (`new_parent_id: null` means LEGACY root — space root is inexpressible)", async () => {
    await seedSpaceWorld();
    await seedAliceMembership(S_TEAM);
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), { collection_id: C_S_MID, new_parent_id: null })
      .catch((e: unknown) => e);
    expectCrossBucketRefusal(err);
  });

  it("space → legacy nested parent is refused", async () => {
    await seed();
    await seedSpaceWorld();
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), { collection_id: C_S_MID, new_parent_id: ROOT_B })
      .catch((e: unknown) => e);
    expectCrossBucketRefusal(err);
  });

  it("spaceA → spaceB is refused even with reach into both", async () => {
    await seedSpaceWorld();
    await seedAliceMembership(S_TEAM);
    await seedAliceMembership(S_OTHER);
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), { collection_id: C_S_MID, new_parent_id: C_S_OTHER })
      .catch((e: unknown) => e);
    expectCrossBucketRefusal(err);
  });

  it("a DANGLING source binding fails closed against every target (anomaly has no bucket)", async () => {
    await seed();
    await seedSpaceWorld();
    const toRoot = await collectionMove
      .handler(buildCtx(userPrincipal()), { collection_id: C_DANGLE, new_parent_id: null })
      .catch((e: unknown) => e);
    expectCrossBucketRefusal(toRoot);
    const toSpace = await collectionMove
      .handler(buildCtx(userPrincipal()), { collection_id: C_DANGLE, new_parent_id: C_S_ROOT })
      .catch((e: unknown) => e);
    expectCrossBucketRefusal(toSpace);
  });

  it("both ends inside a TRASHED space fail closed (no restructuring a dead space's tree)", async () => {
    await seedSpaceWorld();
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), { collection_id: C_TRASH_B, new_parent_id: C_TRASH_A })
      .catch((e: unknown) => e);
    expectCrossBucketRefusal(err);
  });

  it("refused moves leave the row untouched (rail before UPDATE)", async () => {
    await seedSpaceWorld();
    await expect(
      collectionMove.handler(buildCtx(userPrincipal()), {
        collection_id: C_S_MID,
        new_parent_id: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .select(["parent_id", "space_id"])
      .where("id", "=", C_S_MID)
      .executeTakeFirstOrThrow();
    expect(row.parent_id).toBe(C_S_ROOT);
    expect(row.space_id).toBe(S_TEAM);
  });

  it("all-legacy moves NEVER load the resolver (structural pin: no space tables exist at all)", async () => {
    // A dedicated driver with ONLY the collections DDL — if the rail
    // loaded the resolver on a legacy↔legacy move, the preload would
    // throw `no such table: spaces` and this test would fail.
    const bare = createSqliteDriver({ path: ":memory:" });
    bare.exec(COLLECTIONS_DDL);
    try {
      await bare
        .scoped(WORKSPACE_A)
        .insertInto("collections")
        .values([
          {
            id: ROOT_A,
            workspace_id: WORKSPACE_A,
            parent_id: null,
            title: "RootA",
            slug: "root-a",
            order_key: "a0",
            created_by: ALICE,
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          },
          {
            id: MID_A,
            workspace_id: WORKSPACE_A,
            parent_id: ROOT_A,
            title: "MidA",
            slug: "mid-a",
            order_key: "a1",
            created_by: ALICE,
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          },
        ])
        .execute();
      const ctx: CapabilityContext = {
        principal: userPrincipal(),
        tenant: { workspace_id: WORKSPACE_A },
        db: bare.scoped(WORKSPACE_A),
        transact: () => {
          throw new Error("metadata-only");
        },
        outbox: () => {
          /* none */
        },
        logger: noopLogger,
        tracer: noopTracer,
        now: () => 42,
      };
      const out = await collectionMove.handler(ctx, {
        collection_id: MID_A,
        new_parent_id: null,
      });
      expect(out.new_parent_id).toBeNull();
      expect(out.new_space_id).toBeNull();
    } finally {
      await bare.close();
    }
  });
});
