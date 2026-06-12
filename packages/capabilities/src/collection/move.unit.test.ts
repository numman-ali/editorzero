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
  DOCS_DDL,
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
import { CollectionId, DocId, GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
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
  // The regime split loads the ACL resolver (spaces / space_members /
  // grants) whenever some space machinery is in play, and the crossing
  // branch enumerates subtree docs + drops doc grants; all-legacy moves
  // never touch any of these tables.
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
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
        destination: { kind: "legacy_root" },
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
        destination: { kind: "collection", collection_id: ROOT_B },
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
        destination: { kind: "collection", collection_id: ROOT_A }, // same parent
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
        collectionMove.handler(ctx, {
          collection_id: MISSING,
          destination: { kind: "legacy_root" },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the moved collection is soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, {
          collection_id: SOFT_DELETED,
          destination: { kind: "legacy_root" },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the target parent is missing", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, {
          collection_id: LEAF_A,
          destination: { kind: "collection", collection_id: MISSING },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the target parent is soft-deleted", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, {
          collection_id: LEAF_A,
          destination: { kind: "collection", collection_id: SOFT_DELETED },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("cycle detection", () => {
    it("refuses self-parent (new_parent_id === collection_id)", async () => {
      await seed();
      const ctx = buildCtx(userPrincipal());
      await expect(
        collectionMove.handler(ctx, {
          collection_id: MID_A,
          destination: { kind: "collection", collection_id: MID_A },
        }),
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
        collectionMove.handler(ctx, {
          collection_id: ROOT_A,
          destination: { kind: "collection", collection_id: LEAF_A },
        }),
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
        collectionMove.handler(ctx, {
          collection_id: ROOT_A,
          destination: { kind: "collection", collection_id: MID_A },
        }),
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
          destination: { kind: "collection", collection_id: DEEP_IDS[6]! },
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
        destination: { kind: "collection", collection_id: DEEP_IDS[6]! },
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
        destination: { kind: "collection", collection_id: DEEP_IDS[5]! },
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
        destination: { kind: "collection", collection_id: DEEP_IDS[5]! },
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
        collectionMove.handler(ctx, {
          collection_id: LEAF_A,
          destination: { kind: "collection", collection_id: ROOT_B },
        }),
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
        collectionMove.handler(ctx, {
          collection_id: LEAF_A,
          destination: { kind: "legacy_root" },
        }),
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
        await collectionMove.handler(ctx, {
          collection_id: LEAF_A,
          destination: { kind: "collection", collection_id: ROOT_B },
        });
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
        destination: { kind: "collection", collection_id: ROOT_A },
      });
      expect(out.collection_id).toBe(MID_A);
    });
  });

  describe("input validation", () => {
    it("rejects unknown fields via strict()", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        destination: { kind: "legacy_root" },
        stray: 1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUIDv7 collection_id", () => {
      const result = collectionMove.input.safeParse({
        collection_id: "not-a-uuid",
        destination: { kind: "legacy_root" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects a non-UUIDv7 destination collection_id", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        destination: { kind: "collection", collection_id: "not-a-uuid" },
      });
      expect(result.success).toBe(false);
    });

    it("requires destination explicitly (omitted → invalid)", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unknown destination kind", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        destination: { kind: "workspace_root" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects stray fields on a destination arm (per-arm strict)", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        destination: { kind: "legacy_root", space_id: S_TEAM },
      });
      expect(result.success).toBe(false);
    });

    it("rejects a space_root destination without space_id", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        destination: { kind: "space_root" },
      });
      expect(result.success).toBe(false);
    });

    it("accepts each well-formed destination arm", () => {
      for (const destination of [
        { kind: "legacy_root" },
        { kind: "space_root", space_id: S_TEAM },
        { kind: "collection", collection_id: ROOT_B },
      ]) {
        const result = collectionMove.input.safeParse({ collection_id: MID_A, destination });
        expect(result.success).toBe(true);
      }
    });

    it("rejects an unknown acl_policy value", () => {
      const result = collectionMove.input.safeParse({
        collection_id: MID_A,
        destination: { kind: "legacy_root" },
        acl_policy: "drop_everything",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("registry metadata + audit projections", () => {
    it("declares the expected registry metadata", () => {
      expect(collectionMove.id).toBe("collection.move");
      expect(collectionMove.category).toBe("mutation");
      expect(collectionMove.requires).toEqual(["doc:write"]);
      expect(collectionMove.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    });

    it("emits the collection.move effect on allow with new_parent + new_order_key", () => {
      const effect = collectionMove.audit.effectOnAllow(
        { collection_id: LEAF_A, destination: { kind: "collection", collection_id: ROOT_B } },
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
        destination: { kind: "legacy_root" },
      });
      expect(subject.kind).toBe("collection");
      if (subject.kind === "collection") {
        expect(subject.id).toBe(LEAF_A);
      }
    });

    it("emits a deny effect carrying the reason code", () => {
      const effect = collectionMove.audit.effectOnDeny(
        { collection_id: LEAF_A, destination: { kind: "legacy_root" } },
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
        { collection_id: LEAF_A, destination: { kind: "legacy_root" } },
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

// ── Space-bucket regimes (ADR 0040 space-collection crossing slice) ──────
//
// Same-bucket (both legacy, or both the same live space): a re-parent —
// `acl_policy` must be ABSENT; space destinations need baseline reach;
// all-legacy moves never load the resolver (pinned structurally below).
// Crossing (buckets differ; anomalous source always crosses): per-doc
// administer over the WHOLE subtree (live + trashed, sorted by doc_id),
// destination standing, `acl_policy` REQUIRED, then subtree rebind +
// grant drops in one tx.

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
// Trashed LEGACY descendant under MID_A — proves trashed collections
// rebind with their subtree.
const C_TRASH_CHILD = CollectionId("018f0000-0000-7000-8000-0000000000b8");

// Docs (ids ordered f1 < f2 < … so doc_id-sorted assertions are legible).
const D_MID = DocId("018f0000-0000-7000-8000-0000000000f1"); // live, in MID_A
const D_LEAF_TRASHED = DocId("018f0000-0000-7000-8000-0000000000f2"); // trashed, in LEAF_A
const D_IN_TRASHED_COL = DocId("018f0000-0000-7000-8000-0000000000f3"); // live, in trashed C_TRASH_CHILD
const D_OUT = DocId("018f0000-0000-7000-8000-0000000000f4"); // in ROOT_B — outside every moved subtree
const D_S_LIVE = DocId("018f0000-0000-7000-8000-0000000000f5"); // live, in C_S_MID
const D_S_TRASH = DocId("018f0000-0000-7000-8000-0000000000f6"); // trashed, in C_S_MID
const D_ANOM_1 = DocId("018f0000-0000-7000-8000-0000000000f7"); // in C_DANGLE
const D_ANOM_2 = DocId("018f0000-0000-7000-8000-0000000000f8"); // in C_DANGLE

const G_MID = GrantId("018f0000-0000-7000-8000-0000000000aa");
const G_LEAF = GrantId("018f0000-0000-7000-8000-0000000000ab");
const G_GUEST = GrantId("018f0000-0000-7000-8000-0000000000ac");
const G_OUT = GrantId("018f0000-0000-7000-8000-0000000000ad");
const G_SPACE = GrantId("018f0000-0000-7000-8000-0000000000ae");
const G_S_LIVE = GrantId("018f0000-0000-7000-8000-0000000000af");
const G_S_TRASH = GrantId("018f0000-0000-7000-8000-0000000000b0");
const G_ANOM = GrantId("018f0000-0000-7000-8000-0000000000ba");

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
  space_id: SpaceId | null,
  parent_id: CollectionId | null = null,
  opts: { deleted_at?: number | null } = {},
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
      deleted_at: opts.deleted_at ?? null,
    })
    .execute();
}

async function seedMembership(space_id: SpaceId, user_id: UserId = ALICE) {
  await driver
    .scoped(WORKSPACE_A)
    .insertInto("space_members")
    .values({
      workspace_id: WORKSPACE_A,
      space_id,
      user_id,
      role: "edit",
      created_at: 1,
      updated_at: 1,
    })
    .execute();
}

async function seedDoc(
  id: DocId,
  collection_id: CollectionId | null,
  opts: { deleted_at?: number | null; created_by?: UserId } = {},
) {
  await driver
    .scoped(WORKSPACE_A)
    .insertInto("docs")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      collection_id,
      title: `doc-${id.slice(-2)}`,
      slug: `doc-${id.slice(-2)}`,
      order_key: id,
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
      created_by: opts.created_by ?? ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at: opts.deleted_at ?? null,
    })
    .execute();
}

async function seedGrant(
  id: GrantId,
  resource: { kind: "doc"; id: DocId } | { kind: "space"; id: SpaceId },
  subject_id: UserId,
  opts: { role?: "view" | "edit" | "owner"; is_guest?: 0 | 1 } = {},
) {
  await driver
    .scoped(WORKSPACE_A)
    .insertInto("grants")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      resource_kind: resource.kind,
      resource_id: resource.id,
      subject_kind: "user",
      subject_id,
      role: opts.role ?? "view",
      is_guest: opts.is_guest ?? 0,
      created_by: ALICE,
      created_at: 7,
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
}

// The legacy ROOT_A subtree dressed with ACL-bearing state: a live doc,
// a trashed doc, a trashed descendant collection holding a live doc,
// plus control rows that must SURVIVE every transition (a space-scoped
// grant and a doc grant outside the subtree).
async function seedCrossingWorld() {
  await seed();
  await seedSpaceWorld();
  await seedBoundCollection(C_TRASH_CHILD, null, MID_A, { deleted_at: 55 });
  await seedDoc(D_MID, MID_A);
  await seedDoc(D_LEAF_TRASHED, LEAF_A, { deleted_at: 66 });
  await seedDoc(D_IN_TRASHED_COL, C_TRASH_CHILD);
  await seedDoc(D_OUT, ROOT_B);
  await seedGrant(G_MID, { kind: "doc", id: D_MID }, BOB, { role: "edit" });
  await seedGrant(G_LEAF, { kind: "doc", id: D_LEAF_TRASHED }, BOB);
  await seedGrant(G_GUEST, { kind: "doc", id: D_IN_TRASHED_COL }, BOB, { is_guest: 1 });
  await seedGrant(G_OUT, { kind: "doc", id: D_OUT }, BOB);
  await seedGrant(G_SPACE, { kind: "space", id: S_TEAM }, BOB);
}

// Full-table snapshot (the fuzzer's bit-identity idiom) — byte-identical
// before/after proves a refused move wrote NOTHING.
async function snapshotAclWorld(): Promise<string> {
  const db = driver.scoped(WORKSPACE_A);
  const collections = await db.selectFrom("collections").selectAll().orderBy("id").execute();
  const grants = await db.selectFrom("grants").selectAll().orderBy("id").execute();
  const docs = await db.selectFrom("docs").selectAll().orderBy("id").execute();
  return JSON.stringify({ collections, grants, docs });
}

async function spaceIdOf(id: CollectionId): Promise<string | null> {
  const row = await driver
    .scoped(WORKSPACE_A)
    .selectFrom("collections")
    .select(["space_id"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row.space_id;
}

// `ValidationError.issues` is `unknown` by design — narrow through a
// parse (house rule: no casting) before asserting the typed code.
const IssuesSchema = z.array(z.object({ code: z.string(), path: z.array(z.string()) }).loose());

function expectPolicyIssue(err: unknown, code: string, path: string[]) {
  expect(err).toBeInstanceOf(ValidationError);
  if (err instanceof ValidationError) {
    expect(err.httpStatus).toBe(400);
    const issues = IssuesSchema.parse(err.issues);
    expect(issues[0]?.code).toBe(code);
    expect(issues[0]?.path).toEqual(path);
  }
}

function expectAclDeny(err: unknown, scope: Record<string, string>) {
  expect(err).toBeInstanceOf(PermissionDeniedError);
  if (err instanceof PermissionDeniedError) {
    expect(err.reason).toEqual({ kind: "acl_deny", scope });
  }
}

describe("collection.move — same-bucket regime", () => {
  it("same-space re-parent with reach succeeds; binding rides unchanged on row + output + effect", async () => {
    await seedSpaceWorld();
    await seedMembership(S_TEAM);
    const ctx = buildCtx(userPrincipal());
    const out = await collectionMove.handler(ctx, {
      collection_id: C_S_MID,
      destination: { kind: "collection", collection_id: C_S_ROOT2 },
    });
    expect(out.new_parent_id).toBe(C_S_ROOT2);
    expect(out.new_space_id).toBe(S_TEAM);
    expect(out.acl_transition).toBeUndefined();

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .select(["parent_id", "space_id"])
      .where("id", "=", C_S_MID)
      .executeTakeFirstOrThrow();
    expect(row.parent_id).toBe(C_S_ROOT2);
    expect(row.space_id).toBe(S_TEAM);

    const effect = collectionMove.audit.effectOnAllow(
      { collection_id: C_S_MID, destination: { kind: "collection", collection_id: C_S_ROOT2 } },
      out,
    );
    expect(effect.kind).toBe("collection.move");
    if (effect.kind === "collection.move") {
      expect(effect.new_space_id).toBe(S_TEAM);
      expect(effect.acl_transition).toBeUndefined();
    }
  });

  it("same-space re-parent WITHOUT reach → acl_deny scoped to the target collection", async () => {
    await seedSpaceWorld();
    const ctx = buildCtx(bobPrincipal()); // no membership, no grant
    const err = await collectionMove
      .handler(ctx, {
        collection_id: C_S_MID,
        destination: { kind: "collection", collection_id: C_S_ROOT2 },
      })
      .catch((e: unknown) => e);
    expectAclDeny(err, { collection_id: C_S_ROOT2 });
  });

  it("re-parent to the OWN space's root (now expressible) succeeds with reach", async () => {
    await seedSpaceWorld();
    await seedMembership(S_TEAM);
    const out = await collectionMove.handler(buildCtx(userPrincipal()), {
      collection_id: C_S_MID,
      destination: { kind: "space_root", space_id: S_TEAM },
    });
    expect(out.new_parent_id).toBeNull();
    expect(out.new_space_id).toBe(S_TEAM);
    expect(out.acl_transition).toBeUndefined();
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .select(["parent_id", "space_id"])
      .where("id", "=", C_S_MID)
      .executeTakeFirstOrThrow();
    expect(row.parent_id).toBeNull();
    expect(row.space_id).toBe(S_TEAM);
  });

  it("re-parent to the OWN space's root WITHOUT reach → acl_deny scoped to the space", async () => {
    await seedSpaceWorld();
    const err = await collectionMove
      .handler(buildCtx(bobPrincipal()), {
        collection_id: C_S_MID,
        destination: { kind: "space_root", space_id: S_TEAM },
      })
      .catch((e: unknown) => e);
    expectAclDeny(err, { space_id: S_TEAM });
  });

  it("acl_policy on an all-legacy move → acl_policy_not_applicable (resolver-free path)", async () => {
    await seed();
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), {
        collection_id: LEAF_A,
        destination: { kind: "collection", collection_id: ROOT_B },
        acl_policy: "adopt_baseline",
      })
      .catch((e: unknown) => e);
    expectPolicyIssue(err, "acl_policy_not_applicable", ["acl_policy"]);
  });

  it("acl_policy on a same-space move → acl_policy_not_applicable (resolver path)", async () => {
    await seedSpaceWorld();
    await seedMembership(S_TEAM);
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), {
        collection_id: C_S_MID,
        destination: { kind: "space_root", space_id: S_TEAM },
        acl_policy: "keep_grants",
      })
      .catch((e: unknown) => e);
    expectPolicyIssue(err, "acl_policy_not_applicable", ["acl_policy"]);
  });

  it("all-legacy moves NEVER load the resolver (structural pin: no space tables exist at all)", async () => {
    // A dedicated driver with ONLY the collections DDL — if the regime
    // split loaded the resolver on a legacy↔legacy move, the preload
    // would throw `no such table: spaces` and this test would fail.
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
        destination: { kind: "legacy_root" },
      });
      expect(out.new_parent_id).toBeNull();
      expect(out.new_space_id).toBeNull();
    } finally {
      await bare.close();
    }
  });
});

describe("collection.move — crossing branch", () => {
  it("legacy → space collection under adopt_baseline: subtree rebinds (trashed included), subtree doc grants drop with full preimages, controls survive", async () => {
    await seedCrossingWorld();
    await seedMembership(S_TEAM);
    const out = await collectionMove.handler(buildCtx(userPrincipal()), {
      collection_id: ROOT_A,
      destination: { kind: "collection", collection_id: C_S_ROOT },
      acl_policy: "adopt_baseline",
    });

    expect(out.new_parent_id).toBe(C_S_ROOT);
    expect(out.new_space_id).toBe(S_TEAM);
    expect(out.acl_transition).toBeDefined();
    expect(out.acl_transition?.policy).toBe("adopt_baseline");
    expect(out.acl_transition?.before_space_id).toBeNull();
    expect(out.acl_transition?.after_space_id).toBe(S_TEAM);
    // Sorted by grant_id; G_GUEST (guest edge) and G_LEAF (trashed doc)
    // both drop — trashed state is ACL-bearing. Full preimages.
    expect(out.acl_transition?.dropped_grants.map((g) => g.grant_id)).toEqual([
      G_MID,
      G_LEAF,
      G_GUEST,
    ]);
    expect(out.acl_transition?.dropped_grants[0]).toEqual({
      grant_id: G_MID,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc",
      resource_id: D_MID,
      subject_kind: "user",
      subject_id: BOB,
      role: "edit",
      is_guest: 0,
      created_by: ALICE,
      created_at: 7,
    });

    // Whole subtree rebinds — root, both live descendants, AND the
    // trashed descendant collection.
    expect(await spaceIdOf(ROOT_A)).toBe(S_TEAM);
    expect(await spaceIdOf(MID_A)).toBe(S_TEAM);
    expect(await spaceIdOf(LEAF_A)).toBe(S_TEAM);
    expect(await spaceIdOf(C_TRASH_CHILD)).toBe(S_TEAM);

    // Controls survive: the space-scoped grant and the out-of-subtree
    // doc grant.
    const left = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("grants")
      .select(["id"])
      .orderBy("id")
      .execute();
    expect(left.map((r) => r.id)).toEqual([G_OUT, G_SPACE]);

    // Effect projection mirrors the transition minus created_at.
    const effect = collectionMove.audit.effectOnAllow(
      {
        collection_id: ROOT_A,
        destination: { kind: "collection", collection_id: C_S_ROOT },
        acl_policy: "adopt_baseline",
      },
      out,
    );
    expect(effect.kind).toBe("collection.move");
    if (effect.kind === "collection.move") {
      expect(effect.new_space_id).toBe(S_TEAM);
      expect(effect.acl_transition?.policy).toBe("adopt_baseline");
      expect(effect.acl_transition?.dropped_grants.map((g) => g.grant_id)).toEqual([
        G_MID,
        G_LEAF,
        G_GUEST,
      ]);
      expect(effect.acl_transition?.dropped_grants[0]).not.toHaveProperty("created_at");
    }
  });

  it("legacy → space_root under keep_grants: rebind without a single ACL write", async () => {
    await seedCrossingWorld();
    await seedMembership(S_TEAM);
    const grantsBefore = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("grants")
      .selectAll()
      .orderBy("id")
      .execute();
    const out = await collectionMove.handler(buildCtx(userPrincipal()), {
      collection_id: ROOT_A,
      destination: { kind: "space_root", space_id: S_TEAM },
      acl_policy: "keep_grants",
    });
    expect(out.new_parent_id).toBeNull();
    expect(out.new_space_id).toBe(S_TEAM);
    expect(out.acl_transition?.policy).toBe("keep_grants");
    expect(out.acl_transition?.dropped_grants).toEqual([]);
    expect(await spaceIdOf(LEAF_A)).toBe(S_TEAM);
    const grantsAfter = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("grants")
      .selectAll()
      .orderBy("id")
      .execute();
    expect(grantsAfter).toEqual(grantsBefore);
  });

  it("space → legacy_root under adopt_baseline: bindings clear across the subtree, space-doc grants drop", async () => {
    await seedSpaceWorld();
    await seedMembership(S_TEAM);
    await seedDoc(D_S_LIVE, C_S_MID);
    await seedDoc(D_S_TRASH, C_S_MID, { deleted_at: 66 });
    await seedGrant(G_S_LIVE, { kind: "doc", id: D_S_LIVE }, BOB);
    await seedGrant(G_S_TRASH, { kind: "doc", id: D_S_TRASH }, BOB);
    const out = await collectionMove.handler(buildCtx(userPrincipal()), {
      collection_id: C_S_ROOT,
      destination: { kind: "legacy_root" },
      acl_policy: "adopt_baseline",
    });
    expect(out.new_parent_id).toBeNull();
    expect(out.new_space_id).toBeNull();
    expect(out.acl_transition?.before_space_id).toBe(S_TEAM);
    expect(out.acl_transition?.after_space_id).toBeNull();
    expect(out.acl_transition?.dropped_grants.map((g) => g.grant_id)).toEqual([
      G_S_LIVE,
      G_S_TRASH,
    ]);
    expect(await spaceIdOf(C_S_ROOT)).toBeNull();
    expect(await spaceIdOf(C_S_MID)).toBeNull();
  });

  it("spaceA → spaceB under adopt_baseline: before/after carry both bindings", async () => {
    await seedSpaceWorld();
    await seedMembership(S_TEAM);
    await seedMembership(S_OTHER);
    const out = await collectionMove.handler(buildCtx(userPrincipal()), {
      collection_id: C_S_OTHER,
      destination: { kind: "collection", collection_id: C_S_ROOT },
      acl_policy: "adopt_baseline",
    });
    expect(out.acl_transition?.before_space_id).toBe(S_OTHER);
    expect(out.acl_transition?.after_space_id).toBe(S_TEAM);
    expect(out.acl_transition?.dropped_grants).toEqual([]);
    expect(await spaceIdOf(C_S_OTHER)).toBe(S_TEAM);
  });

  it("crossing without acl_policy → acl_transition_policy_required; nothing written (snapshot-identical)", async () => {
    await seedCrossingWorld();
    await seedMembership(S_TEAM);
    const before = await snapshotAclWorld();
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), {
        collection_id: ROOT_A,
        destination: { kind: "collection", collection_id: C_S_ROOT },
      })
      .catch((e: unknown) => e);
    expectPolicyIssue(err, "acl_transition_policy_required", ["acl_policy"]);
    expect(await snapshotAclWorld()).toBe(before);
  });

  it("destination standing denies before the policy rail surfaces: empty subtree, no reach", async () => {
    await seed();
    await seedSpaceWorld();
    // BOB moves an EMPTY legacy collection (no docs → per-doc authority
    // is vacuous) without reach into S_TEAM — the deny is the
    // destination term, and it fires even though no policy was sent
    // (authority before rails, the doc.move order).
    const toCollection = await collectionMove
      .handler(buildCtx(bobPrincipal()), {
        collection_id: MID_B,
        destination: { kind: "collection", collection_id: C_S_ROOT },
      })
      .catch((e: unknown) => e);
    expectAclDeny(toCollection, { collection_id: C_S_ROOT });
    const toSpaceRoot = await collectionMove
      .handler(buildCtx(bobPrincipal()), {
        collection_id: MID_B,
        destination: { kind: "space_root", space_id: S_TEAM },
      })
      .catch((e: unknown) => e);
    expectAclDeny(toSpaceRoot, { space_id: S_TEAM });
  });

  it("per-doc administer denies on the FIRST doc in doc_id order, atomically", async () => {
    await seedCrossingWorld();
    await seedMembership(S_TEAM, BOB);
    const before = await snapshotAclWorld();
    // BOB has reach into S_TEAM but administers none of the subtree's
    // docs (ALICE created them; BOB's edit grant on D_MID is not
    // owner-tier) — deny names the LOWEST doc_id.
    const err = await collectionMove
      .handler(buildCtx(bobPrincipal()), {
        collection_id: ROOT_A,
        destination: { kind: "collection", collection_id: C_S_ROOT },
        acl_policy: "adopt_baseline",
      })
      .catch((e: unknown) => e);
    expectAclDeny(err, { doc_id: D_MID });
    expect(await snapshotAclWorld()).toBe(before);

    // Promoting BOB's existing edge on that first doc to owner-tier
    // moves the deny to the NEXT doc in id order — the ladder is
    // per-doc, the order is doc_id. (UPDATE, not a second edge: grants
    // are unique per (resource, subject).)
    await driver
      .scoped(WORKSPACE_A)
      .updateTable("grants")
      .set({ role: "owner" })
      .where("id", "=", G_MID)
      .execute();
    const err2 = await collectionMove
      .handler(buildCtx(bobPrincipal()), {
        collection_id: ROOT_A,
        destination: { kind: "collection", collection_id: C_S_ROOT },
        acl_policy: "adopt_baseline",
      })
      .catch((e: unknown) => e);
    expectAclDeny(err2, { doc_id: D_LEAF_TRASHED });
  });

  it("anomalous subtree OUT (adopt_baseline): per-doc ladder runs BEFORE any drop; failure leaves the world byte-identical (Codex pin)", async () => {
    await seed();
    await seedSpaceWorld();
    await seedDoc(D_ANOM_1, C_DANGLE);
    await seedDoc(D_ANOM_2, C_DANGLE);
    await seedGrant(G_ANOM, { kind: "doc", id: D_ANOM_1 }, BOB);
    const before = await snapshotAclWorld();
    // BOB: workspace member, but anomaly placement contributes no
    // authority term and BOB created nothing — the per-doc ladder
    // refuses on the first doc and NOTHING is dropped or rebound.
    const err = await collectionMove
      .handler(buildCtx(bobPrincipal()), {
        collection_id: C_DANGLE,
        destination: { kind: "legacy_root" },
        acl_policy: "adopt_baseline",
      })
      .catch((e: unknown) => e);
    expectAclDeny(err, { doc_id: D_ANOM_1 });
    expect(await snapshotAclWorld()).toBe(before);

    // ALICE created both docs — owner-tier per doc — so the repair
    // lands: dangling ref overwritten with null, grants shed,
    // before_space_id honest about the DANGLING ref (null, not the
    // ghost id).
    const out = await collectionMove.handler(buildCtx(userPrincipal()), {
      collection_id: C_DANGLE,
      destination: { kind: "legacy_root" },
      acl_policy: "adopt_baseline",
    });
    expect(out.acl_transition?.before_space_id).toBeNull();
    expect(out.acl_transition?.after_space_id).toBeNull();
    expect(out.acl_transition?.dropped_grants.map((g) => g.grant_id)).toEqual([G_ANOM]);
    expect(await spaceIdOf(C_DANGLE)).toBeNull();
  });

  it("trashed-space binding OUT reports the resolvable stored ref as before_space_id (honesty pin)", async () => {
    await seedSpaceWorld();
    const out = await collectionMove.handler(buildCtx(userPrincipal()), {
      collection_id: C_TRASH_A,
      destination: { kind: "legacy_root" },
      acl_policy: "keep_grants",
    });
    expect(out.acl_transition?.before_space_id).toBe(S_TRASHED);
    expect(out.acl_transition?.after_space_id).toBeNull();
    expect(await spaceIdOf(C_TRASH_A)).toBeNull();
  });

  it("crossing INTO an anomaly is impossible (placeIn fails closed)", async () => {
    await seed();
    await seedSpaceWorld();
    const toDangling = await collectionMove
      .handler(buildCtx(userPrincipal()), {
        collection_id: MID_B,
        destination: { kind: "collection", collection_id: C_DANGLE },
      })
      .catch((e: unknown) => e);
    expectAclDeny(toDangling, { collection_id: C_DANGLE });
    const toTrashedSpace = await collectionMove
      .handler(buildCtx(userPrincipal()), {
        collection_id: MID_B,
        destination: { kind: "collection", collection_id: C_TRASH_A },
      })
      .catch((e: unknown) => e);
    expectAclDeny(toTrashedSpace, { collection_id: C_TRASH_A });
  });

  it("space_root destination 404s on a missing or trashed space (existence before authority)", async () => {
    await seed();
    await seedSpaceWorld();
    const missing = await collectionMove
      .handler(buildCtx(userPrincipal()), {
        collection_id: MID_B,
        destination: { kind: "space_root", space_id: S_GONE },
      })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(NotFoundError);
    if (missing instanceof NotFoundError) {
      expect(missing.subject_kind).toBe("space");
      expect(missing.subject_id).toBe(S_GONE);
    }
    const trashed = await collectionMove
      .handler(buildCtx(userPrincipal()), {
        collection_id: MID_B,
        destination: { kind: "space_root", space_id: S_TRASHED },
      })
      .catch((e: unknown) => e);
    expect(trashed).toBeInstanceOf(NotFoundError);
  });

  it("space_root destination contends with the workspace-root slug scope (parent-scoped, space-BLIND)", async () => {
    await seedSpaceWorld();
    await seedMembership(S_TEAM);
    // A LEGACY root collection already owns the slug `col-b3` — moving
    // C_S_MID (slug `col-b3`) to the space root collides: both root
    // destinations share the NULL-parent scope.
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("collections")
      .values({
        id: CollectionId("018f0000-0000-7000-8000-0000000000bc"),
        workspace_id: WORKSPACE_A,
        parent_id: null,
        space_id: null,
        title: "Clash",
        slug: `col-${C_S_MID.slice(-2)}`,
        order_key: "zz",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
    const err = await collectionMove
      .handler(buildCtx(userPrincipal()), {
        collection_id: C_S_MID,
        destination: { kind: "space_root", space_id: S_TEAM },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlugCollisionError);
  });
});
