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
import {
  AgentId,
  CollectionId,
  DocId,
  GrantId,
  SpaceId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDocReadResolver } from "../acl/ceiling";
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
        access_mode: "space",
        published_slug: null,
        published_at: null,
        render_version: 0,
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
        access_mode: "space",
        published_slug: null,
        published_at: null,
        render_version: 0,
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
        access_mode: "space",
        published_slug: null,
        published_at: null,
        render_version: 0,
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
          access_mode: "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
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
          access_mode: "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
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
          access_mode: "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
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

  // ── Cross-boundary ACL transitions (ADR 0040 §7, Step-8) ────────────────
  //
  // The fixtures below build the full bucket landscape: a live closed
  // team space (ALICE + CAROL are members; BOB is not), ALICE's
  // personal space, a TRASHED space (its live collection = anomaly
  // placement), and a collection whose space ref DANGLES (no spaces
  // row at all). Docs of every source kind carry grants in both lanes
  // (non-guest + guest, user + agent subjects) so adopt_baseline's
  // "shed every crossing" semantics are pinned against the real edge
  // set, not a single convenient row.

  describe("cross-boundary ACL transition (ADR 0040 §7, Step-8)", () => {
    const BOB = UserId("018f0000-0000-7000-8000-0000000000a2");
    const CAROL = UserId("018f0000-0000-7000-8000-0000000000a3");
    const ADMIN_U = UserId("018f0000-0000-7000-8000-0000000000a4");
    const NON_MEM = UserId("018f0000-0000-7000-8000-0000000000a5");
    const AG = AgentId("018f0000-0000-7000-8000-0000000000b1");

    const S_TEAM = SpaceId("018f0000-0000-7000-8000-0000000000e1");
    const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e2");
    const S_GONE = SpaceId("018f0000-0000-7000-8000-0000000000e3"); // never inserted
    const S_PERS = SpaceId("018f0000-0000-7000-8000-0000000000e4");

    const C_TEAM = CollectionId("018f0000-0000-7000-8000-0000000000c4");
    const C_ANOM = CollectionId("018f0000-0000-7000-8000-0000000000c5");
    const C_DANGLING = CollectionId("018f0000-0000-7000-8000-0000000000c6");
    const C_PERS = CollectionId("018f0000-0000-7000-8000-0000000000c7");

    const D_L = DocId("018f0000-0000-7000-8000-0000000000d4");
    const D_T = DocId("018f0000-0000-7000-8000-0000000000d5");
    const D_AN = DocId("018f0000-0000-7000-8000-0000000000d6");
    const D_DG = DocId("018f0000-0000-7000-8000-0000000000d7");
    const D_PRIV = DocId("018f0000-0000-7000-8000-0000000000d8");
    const D_PERS = DocId("018f0000-0000-7000-8000-0000000000da");

    const G1 = GrantId("018f0000-0000-7000-8000-0000000000f1"); // D_L: BOB non-guest view
    const G2 = GrantId("018f0000-0000-7000-8000-0000000000f2"); // D_L: NON_MEM guest view
    const G3 = GrantId("018f0000-0000-7000-8000-0000000000f3"); // D_L: AG guest edit
    const G_OWN = GrantId("018f0000-0000-7000-8000-0000000000f4"); // D_AN: BOB non-guest OWNER
    const G5 = GrantId("018f0000-0000-7000-8000-0000000000f5"); // D_PRIV: BOB non-guest view
    const G6 = GrantId("018f0000-0000-7000-8000-0000000000f6"); // D_PRIV: NON_MEM guest view

    async function seedSpaceRow(
      id: SpaceId,
      opts: { deleted_at?: number | null; personalOwner?: UserId | null } = {},
    ) {
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("spaces")
        .values({
          id,
          workspace_id: WORKSPACE_A,
          kind: (opts.personalOwner ?? null) === null ? "team" : "personal",
          type: (opts.personalOwner ?? null) === null ? "closed" : "private",
          owner_user_id: opts.personalOwner ?? null,
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

    async function seedSpaceCollection(id: CollectionId, space_id: SpaceId) {
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("collections")
        .values({
          id,
          workspace_id: WORKSPACE_A,
          parent_id: null,
          space_id,
          title: `col-${id.slice(-2)}`,
          slug: `col-${id.slice(-2)}`,
          order_key: `b${id.slice(-2)}`,
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
    }

    async function seedCrossDoc(
      id: DocId,
      collection_id: CollectionId | null,
      opts: { access_mode?: "space" | "private" } = {},
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
          access_mode: opts.access_mode ?? "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
    }

    async function seedGrantRow(params: {
      id: GrantId;
      resource_id: string;
      subject_kind: "user" | "agent";
      subject_id: string;
      role: "owner" | "edit" | "comment" | "view";
      is_guest: 0 | 1;
    }) {
      await driver
        .scoped(WORKSPACE_A)
        .insertInto("grants")
        .values({
          id: params.id,
          workspace_id: WORKSPACE_A,
          resource_kind: "doc",
          resource_id: params.resource_id,
          subject_kind: params.subject_kind,
          subject_id: params.subject_id,
          role: params.role,
          is_guest: params.is_guest,
          created_by: ALICE,
          created_at: 7,
        })
        .execute();
    }

    async function seedCross() {
      await seed();
      await seedSpaceRow(S_TEAM);
      await seedSpaceRow(S_TRASHED, { deleted_at: 99 });
      await seedSpaceRow(S_PERS, { personalOwner: ALICE });
      await seedSpaceCollection(C_TEAM, S_TEAM);
      await seedSpaceCollection(C_ANOM, S_TRASHED); // live collection, trashed space → anomaly
      await seedSpaceCollection(C_DANGLING, S_GONE); // live collection, NO spaces row → anomaly
      await seedSpaceCollection(C_PERS, S_PERS);

      for (const [user_id, role] of [
        [ALICE, "edit"],
        [CAROL, "edit"],
      ] as const) {
        await driver
          .scoped(WORKSPACE_A)
          .insertInto("space_members")
          .values({
            workspace_id: WORKSPACE_A,
            space_id: S_TEAM,
            user_id,
            role,
            created_at: 1,
            updated_at: 1,
          })
          .execute();
      }

      await seedCrossDoc(D_L, null);
      await seedCrossDoc(D_T, C_TEAM);
      await seedCrossDoc(D_AN, C_ANOM);
      await seedCrossDoc(D_DG, C_DANGLING);
      await seedCrossDoc(D_PRIV, null, { access_mode: "private" });
      await seedCrossDoc(D_PERS, C_PERS);

      // D_L carries the full edge zoo — deliberately inserted OUT of
      // grant_id order so the sorted echo below is proved, not assumed.
      await seedGrantRow({
        id: G3,
        resource_id: D_L,
        subject_kind: "agent",
        subject_id: AG,
        role: "edit",
        is_guest: 1,
      });
      await seedGrantRow({
        id: G1,
        resource_id: D_L,
        subject_kind: "user",
        subject_id: BOB,
        role: "view",
        is_guest: 0,
      });
      await seedGrantRow({
        id: G2,
        resource_id: D_L,
        subject_kind: "user",
        subject_id: NON_MEM,
        role: "view",
        is_guest: 1,
      });
      // BOB's non-guest OWNER grant on the anomalous doc — the
      // MUST-FIX fixture (administers the source, no destination reach).
      await seedGrantRow({
        id: G_OWN,
        resource_id: D_AN,
        subject_kind: "user",
        subject_id: BOB,
        role: "owner",
        is_guest: 0,
      });
      await seedGrantRow({
        id: G5,
        resource_id: D_PRIV,
        subject_kind: "user",
        subject_id: BOB,
        role: "view",
        is_guest: 0,
      });
      await seedGrantRow({
        id: G6,
        resource_id: D_PRIV,
        subject_kind: "user",
        subject_id: NON_MEM,
        role: "view",
        is_guest: 1,
      });
    }

    function alice(): UserPrincipal {
      return {
        kind: "user",
        id: ALICE,
        workspace_id: WORKSPACE_A,
        roles: ["member"],
        session_id: null,
        token_id: null,
      };
    }

    function member(id: UserId, roles: readonly ("member" | "admin")[] = ["member"]) {
      return {
        kind: "user" as const,
        id,
        workspace_id: WORKSPACE_A,
        roles,
        session_id: null,
        token_id: null,
      };
    }

    async function grantRowsFor(doc: DocId) {
      return driver
        .scoped(WORKSPACE_A)
        .selectFrom("grants")
        .select(["id"])
        .where("resource_kind", "=", "doc")
        .where("resource_id", "=", doc)
        .orderBy("id")
        .execute();
    }

    it("same-bucket move with acl_policy → typed 400 acl_policy_not_applicable (and no write)", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      try {
        await docMove.handler(ctx, {
          doc_id: DOC_ROOT,
          new_collection_id: COLL_A,
          acl_policy: "keep_grants",
        });
        throw new Error("expected ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        if (err instanceof ValidationError) {
          expect(JSON.stringify(err.issues)).toContain("acl_policy_not_applicable");
        }
      }
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["collection_id"])
        .where("id", "=", DOC_ROOT)
        .executeTakeFirst();
      expect(row?.collection_id).toBeNull();
    });

    it("cross-boundary move without acl_policy → typed 400 acl_transition_policy_required (and no write)", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      try {
        await docMove.handler(ctx, { doc_id: D_L, new_collection_id: C_TEAM });
        throw new Error("expected ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        if (err instanceof ValidationError) {
          expect(JSON.stringify(err.issues)).toContain("acl_transition_policy_required");
        }
      }
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["collection_id"])
        .where("id", "=", D_L)
        .executeTakeFirst();
      expect(row?.collection_id).toBeNull();
    });

    it("authority precedes the policy rail: a non-administer caller gets acl_deny, never the 400 hint", async () => {
      await seedCross();
      // BOB reads D_L via his view grant but does not administer it —
      // the missing-policy 400 must NOT fire first (it would leak that
      // the target crosses a boundary to a caller without authority).
      const ctx = buildCtx(member(BOB));
      try {
        await docMove.handler(ctx, { doc_id: D_L, new_collection_id: C_TEAM });
        throw new Error("expected PermissionDeniedError");
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionDeniedError);
        if (err instanceof PermissionDeniedError && err.reason.kind === "acl_deny") {
          expect(err.reason.scope).toEqual({ doc_id: D_L });
        }
      }
    });

    it("legacy→space adopt_baseline drops ALL doc-scoped grants (guest edges included) and echoes sorted full preimages", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      const out = await docMove.handler(ctx, {
        doc_id: D_L,
        new_collection_id: C_TEAM,
        acl_policy: "adopt_baseline",
      });

      expect(out.new_collection_id).toBe(C_TEAM);
      expect(out.acl_transition).toBeDefined();
      expect(out.acl_transition?.policy).toBe("adopt_baseline");
      expect(out.acl_transition?.before_space_id).toBeNull();
      expect(out.acl_transition?.after_space_id).toBe(S_TEAM);
      // Sorted by grant_id (G1 < G2 < G3) despite G3-first insertion;
      // full preimages — the hard-delete-preimage rule.
      expect(out.acl_transition?.dropped_grants.map((g) => g.grant_id)).toEqual([G1, G2, G3]);
      const bobRow = out.acl_transition?.dropped_grants[0];
      expect(bobRow).toEqual({
        grant_id: G1,
        workspace_id: WORKSPACE_A,
        resource_kind: "doc",
        resource_id: D_L,
        subject_kind: "user",
        subject_id: BOB,
        role: "view",
        is_guest: 0,
        created_by: ALICE,
        created_at: 7,
      });
      const guestAgent = out.acl_transition?.dropped_grants[2];
      expect(guestAgent?.subject_kind).toBe("agent");
      expect(guestAgent?.is_guest).toBe(1);

      expect(await grantRowsFor(D_L)).toEqual([]);
      // Unrelated docs' grants are untouched.
      expect((await grantRowsFor(D_PRIV)).map((r) => r.id)).toEqual([G5, G6]);
    });

    it("legacy→space keep_grants performs zero ACL writes — every row survives", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      const out = await docMove.handler(ctx, {
        doc_id: D_L,
        new_collection_id: C_TEAM,
        acl_policy: "keep_grants",
      });
      expect(out.acl_transition?.policy).toBe("keep_grants");
      expect(out.acl_transition?.dropped_grants).toEqual([]);
      expect((await grantRowsFor(D_L)).map((r) => r.id)).toEqual([G1, G2, G3]);
    });

    it("space→legacy widen carries before/after space bindings", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      const out = await docMove.handler(ctx, {
        doc_id: D_T,
        new_collection_id: null,
        acl_policy: "keep_grants",
      });
      expect(out.new_collection_id).toBeNull();
      expect(out.acl_transition?.before_space_id).toBe(S_TEAM);
      expect(out.acl_transition?.after_space_id).toBeNull();
    });

    it("personal→team promotion rides the same branch (creator administers, member reach places)", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      const out = await docMove.handler(ctx, {
        doc_id: D_PERS,
        new_collection_id: C_TEAM,
        acl_policy: "adopt_baseline",
      });
      expect(out.acl_transition?.before_space_id).toBe(S_PERS);
      expect(out.acl_transition?.after_space_id).toBe(S_TEAM);
    });

    it("MUST-FIX pin: owner-grant administer on an anomalous doc cannot repair into a space without standing", async () => {
      await seedCross();
      // BOB holds a NON-guest owner grant on D_AN → administers the
      // source (anomaly collapses to owner-tier, and he IS owner-tier).
      // But he has no membership/grant/baseline into S_TEAM —
      // `canPlaceIn(target)` must refuse; owner-tier repair is NOT
      // "repair anywhere".
      const ctx = buildCtx(member(BOB));
      try {
        await docMove.handler(ctx, {
          doc_id: D_AN,
          new_collection_id: C_TEAM,
          acl_policy: "adopt_baseline",
        });
        throw new Error("expected PermissionDeniedError");
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionDeniedError);
        if (err instanceof PermissionDeniedError && err.reason.kind === "acl_deny") {
          // Scoped to the COLLECTION — the destination-standing check,
          // not the source administer (which passed).
          expect(err.reason.scope).toEqual({ collection_id: C_TEAM });
        }
      }
      const row = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["collection_id"])
        .where("id", "=", D_AN)
        .executeTakeFirst();
      expect(row?.collection_id).toBe(C_ANOM);
    });

    it("anomaly→live repair works for the creator; before_space_id is the stored (trashed) ref", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      const out = await docMove.handler(ctx, {
        doc_id: D_AN,
        new_collection_id: C_TEAM,
        acl_policy: "adopt_baseline",
      });
      // The trashed space still EXISTS, so the stored ref is honest —
      // null is reserved for refs that dangle entirely.
      expect(out.acl_transition?.before_space_id).toBe(S_TRASHED);
      expect(out.acl_transition?.after_space_id).toBe(S_TEAM);
      expect(out.acl_transition?.dropped_grants.map((g) => g.grant_id)).toEqual([G_OWN]);
      expect(await grantRowsFor(D_AN)).toEqual([]);
    });

    it("anomaly with a DANGLING space ref reports before_space_id null (repair to root)", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      const out = await docMove.handler(ctx, {
        doc_id: D_DG,
        new_collection_id: null,
        acl_policy: "keep_grants",
      });
      expect(out.new_collection_id).toBeNull();
      expect(out.acl_transition?.before_space_id).toBeNull();
      expect(out.acl_transition?.after_space_id).toBeNull();
    });

    it("workspace admin cannot move an anomalous doc — owner-tier collapse holds (admin backstop is not owner-tier)", async () => {
      await seedCross();
      // Give the admin a guest VIEW grant so canRead passes and the
      // deny provably comes from the administer ladder, not the read
      // ceiling. Guest grants never confer authority; the legacy admin
      // backstop does not apply to anomaly placements.
      await seedGrantRow({
        id: GrantId("018f0000-0000-7000-8000-0000000000f7"),
        resource_id: D_AN,
        subject_kind: "user",
        subject_id: ADMIN_U,
        role: "view",
        is_guest: 1,
      });
      const ctx = buildCtx(member(ADMIN_U, ["admin"]));
      try {
        await docMove.handler(ctx, {
          doc_id: D_AN,
          new_collection_id: C_TEAM,
          acl_policy: "adopt_baseline",
        });
        throw new Error("expected PermissionDeniedError");
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionDeniedError);
        if (err instanceof PermissionDeniedError && err.reason.kind === "acl_deny") {
          expect(err.reason.scope).toEqual({ doc_id: D_AN });
        }
      }
    });

    it("into-anomaly is refused — canPlaceIn fails closed on a live collection bound to a trashed space", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      try {
        await docMove.handler(ctx, {
          doc_id: D_L,
          new_collection_id: C_ANOM,
          acl_policy: "adopt_baseline",
        });
        throw new Error("expected PermissionDeniedError");
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionDeniedError);
        if (err instanceof PermissionDeniedError && err.reason.kind === "acl_deny") {
          expect(err.reason.scope).toEqual({ collection_id: C_ANOM });
        }
      }
    });

    it("private doc + adopt_baseline crossing: zero grants remain AND destination members still cannot read it", async () => {
      await seedCross();
      const ctx = buildCtx(alice());
      const out = await docMove.handler(ctx, {
        doc_id: D_PRIV,
        new_collection_id: C_TEAM,
        acl_policy: "adopt_baseline",
      });
      expect(out.acl_transition?.dropped_grants.map((g) => g.grant_id)).toEqual([G5, G6]);
      expect(await grantRowsFor(D_PRIV)).toEqual([]);

      // The Codex pin: adopt is "shed crossings", NOT "set
      // access_mode=space". The doc rides into S_TEAM still private —
      // creator-only until re-granted.
      const moved = await driver
        .scoped(WORKSPACE_A)
        .selectFrom("docs")
        .select(["id", "created_by", "access_mode", "collection_id"])
        .where("id", "=", D_PRIV)
        .executeTakeFirstOrThrow();
      expect(moved.access_mode).toBe("private");
      expect(moved.collection_id).toBe(C_TEAM);

      const db = driver.scoped(WORKSPACE_A);
      const carol = await loadDocReadResolver(db, member(CAROL));
      // Control: CAROL's S_TEAM membership is real — she reads the
      // space-mode doc that lives there…
      const spaceDoc = await db
        .selectFrom("docs")
        .select(["id", "created_by", "access_mode", "collection_id"])
        .where("id", "=", D_T)
        .executeTakeFirstOrThrow();
      expect(carol.canRead(spaceDoc)).toBe(true);
      // …but NOT the private doc that just adopted her space's baseline.
      expect(carol.canRead(moved)).toBe(false);
      // And BOB's dropped grant no longer reads.
      const bob = await loadDocReadResolver(db, member(BOB));
      expect(bob.canRead(moved)).toBe(false);
    });

    it("schema rail: acl_policy accepts only the two policy literals", () => {
      expect(
        docMove.input.safeParse({
          doc_id: D_L,
          new_collection_id: C_TEAM,
          acl_policy: "adopt_baseline",
        }).success,
      ).toBe(true);
      expect(
        docMove.input.safeParse({
          doc_id: D_L,
          new_collection_id: C_TEAM,
          acl_policy: "keep_grants",
        }).success,
      ).toBe(true);
      expect(
        docMove.input.safeParse({
          doc_id: D_L,
          new_collection_id: C_TEAM,
          acl_policy: "merge",
        }).success,
      ).toBe(false);
    });

    it("effectOnAllow projects the transition through the OUTPUT (preimages without created_at)", () => {
      const effect = docMove.audit.effectOnAllow(
        { doc_id: D_L, new_collection_id: C_TEAM, acl_policy: "adopt_baseline" },
        {
          doc_id: D_L,
          new_collection_id: C_TEAM,
          new_order_key: "018f0000-0000-7000-8000-000000000111",
          updated_at: 42,
          acl_transition: {
            policy: "adopt_baseline",
            before_space_id: null,
            after_space_id: S_TEAM,
            dropped_grants: [
              {
                grant_id: G1,
                workspace_id: WORKSPACE_A,
                resource_kind: "doc",
                resource_id: D_L,
                subject_kind: "user",
                subject_id: BOB,
                role: "view",
                is_guest: 0,
                created_by: ALICE,
                created_at: 7,
              },
            ],
          },
        },
      );
      expect(effect.kind).toBe("doc.move");
      if (effect.kind === "doc.move") {
        expect(effect.acl_transition?.policy).toBe("adopt_baseline");
        expect(effect.acl_transition?.after_space_id).toBe(S_TEAM);
        const entry = effect.acl_transition?.dropped_grants[0];
        expect(entry?.grant_id).toBe(G1);
        expect(entry?.is_guest).toBe(0);
        // The effect mirrors GrantState — timestamps stay out of replay.
        expect(entry !== undefined && "created_at" in entry).toBe(false);
      }
    });

    it("effectOnAllow omits acl_transition entirely on a same-bucket move", () => {
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
        expect("acl_transition" in effect).toBe(false);
      }
    });
  });
});
