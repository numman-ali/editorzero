/**
 * `collection.create` — capability-level integration test.
 *
 * Runs the handler against a real in-memory SQLite driver with the
 * combined `COLLECTIONS_DDL + DOCS_DDL` fixture. The parent-validation
 * path, the ancestor-depth walk, and the input-boundary rejections
 * are exercised end-to-end. Cross-tenant isolation + dispatcher audit
 * emission are owned by their own tests; this file asserts only that
 * `collection.create` composes with those layers correctly.
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
import {
  AgentId,
  CollectionId,
  GrantId,
  SpaceId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { collectionCreate } from "./create";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000a2");
const MISSING_COLLECTION = CollectionId("018f0000-0000-7000-8000-0000000000c9");
const AGENT_BOT42 = AgentId("018f0000-0000-7000-8000-0000000000f1");
const TOKEN = TokenId("018f0000-0000-7000-8000-0000000000e1");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  // Space-binding arms load the ACL resolver, which reads spaces /
  // space_members / grants — every child create now touches these
  // tables even on the legacy (no-space) path.
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

function agentPrincipal(opts: {
  owner?: UserPrincipal["id"] | null;
  acting_as?: UserPrincipal["id"];
}): AgentPrincipal {
  const base: AgentPrincipal = {
    kind: "agent",
    id: AGENT_BOT42,
    workspace_id: WORKSPACE_A,
    owner_user_id: opts.owner ?? null,
    scopes: ["doc:write"],
    token_id: TOKEN,
    token_kind: "api-key",
  };
  return opts.acting_as !== undefined ? { ...base, acting_as: opts.acting_as } : base;
}

function buildCtx(principal: Principal, now = () => 1): CapabilityContext {
  return {
    principal,
    tenant: { workspace_id: principal.workspace_id },
    db: driver.scoped(principal.workspace_id),
    transact: () => {
      throw new Error("collection.create must not call ctx.transact (metadata-only capability)");
    },
    outbox: () => {
      /* collection.create emits no outbox events in v1 */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now,
  };
}

/**
 * Seed a chain of `n` nested collections (root, root→c1, root→c1→c2, …).
 * Returns the deepest collection's id — the one whose depth equals
 * `n - 1`. Used to probe the depth-walk limits.
 */
async function seedChain(n: number): Promise<CollectionId> {
  const db = driver.scoped(WORKSPACE_A);
  let parent: CollectionId | null = null;
  let last: CollectionId | null = null;
  for (let i = 0; i < n; i++) {
    const id = CollectionId(
      `018f0000-0000-7000-8000-${(0xd00 + i).toString(16).padStart(12, "0")}`,
    );
    await db
      .insertInto("collections")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        parent_id: parent,
        title: `Chain ${i}`,
        slug: `chain-${i}`,
        order_key: id,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
    parent = id;
    last = id;
  }
  if (last === null) throw new Error("seedChain requires n >= 1");
  return last;
}

// ── Happy path ───────────────────────────────────────────────────────────

describe("collection.create handler", () => {
  it("mints a UUIDv7 collection_id, writes a root collection (parent_id omitted)", async () => {
    const ctx = buildCtx(userPrincipal(), () => 42);
    const out = await collectionCreate.handler(ctx, { title: "Reference" });

    expect(out.workspace_id).toBe(WORKSPACE_A);
    expect(out.parent_id).toBeNull();
    expect(out.title).toBe("Reference");
    expect(out.slug).toBe("reference");
    expect(out.order_key).toBe(out.collection_id);
    // created_by is carried on the output so the audit effect can record it
    // (invariant 3a attribution — Codex review HIGH 1).
    expect(out.created_by).toBe(ALICE);
    // UUIDv7 round-trip pins the brand — a freshly-minted non-v7 would throw.
    expect(CollectionId(out.collection_id)).toBe(out.collection_id);

    const rows = await driver.scoped(WORKSPACE_A).selectFrom("collections").selectAll().execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.id).toBe(out.collection_id);
    expect(row.parent_id).toBeNull();
    expect(row.title).toBe("Reference");
    expect(row.slug).toBe("reference");
    expect(row.created_by).toBe(ALICE);
    expect(row.created_at).toBe(42);
    expect(row.updated_at).toBe(42);
    expect(row.deleted_at).toBeNull();
  });

  it("accepts an explicit `parent_id: null` on the wire (equivalent to omission)", async () => {
    const ctx = buildCtx(userPrincipal());
    const out = await collectionCreate.handler(ctx, { title: "Explicit root", parent_id: null });
    expect(out.parent_id).toBeNull();
  });

  it("writes a nested collection under an existing live parent", async () => {
    const parentId = await seedChain(1);
    const ctx = buildCtx(userPrincipal());
    const out = await collectionCreate.handler(ctx, {
      title: "Child",
      parent_id: parentId,
    });
    expect(out.parent_id).toBe(parentId);

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", out.collection_id)
      .executeTakeFirstOrThrow();
    expect(row.parent_id).toBe(parentId);
  });

  it("slugifies emoji / non-ASCII titles; falls back to `untitled`", async () => {
    const ctx = buildCtx(userPrincipal());
    const a = await collectionCreate.handler(ctx, { title: "Heading · with 🎉 mixed chars" });
    expect(a.slug).toBe("heading-with-mixed-chars");
    const b = await collectionCreate.handler(ctx, { title: "🎉🎊" });
    expect(b.slug).toBe("untitled");
  });

  it("trims surrounding whitespace; rejects whitespace-only titles at the schema boundary", async () => {
    const blank = collectionCreate.input.safeParse({ title: "   " });
    expect(blank.success).toBe(false);
    if (!blank.success) {
      expect(blank.error.issues[0]?.path).toEqual(["title"]);
    }
    const alsoBlank = collectionCreate.input.safeParse({ title: "" });
    expect(alsoBlank.success).toBe(false);

    const parsed = collectionCreate.input.parse({ title: "  Reference  " });
    expect(parsed.title).toBe("Reference");

    const ctx = buildCtx(userPrincipal());
    const out = await collectionCreate.handler(ctx, parsed);
    expect(out.title).toBe("Reference");
  });

  it("rejects unknown input fields via strict() (no silent drop on typos)", () => {
    const result = collectionCreate.input.safeParse({
      title: "X",
      not_a_field: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("generates a unique collection_id per call", async () => {
    const ctx = buildCtx(userPrincipal());
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const out = await collectionCreate.handler(ctx, { title: `C ${i}` });
      ids.add(out.collection_id);
    }
    expect(ids.size).toBe(10);
  });
});

// ── Parent validation + depth walk ───────────────────────────────────────

describe("collection.create — parent validation", () => {
  it("throws NotFoundError when parent_id does not exist", async () => {
    const ctx = buildCtx(userPrincipal());
    const err = await collectionCreate
      .handler(ctx, { title: "orphan", parent_id: MISSING_COLLECTION })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("collection");
      expect(err.subject_id).toBe(MISSING_COLLECTION);
      expect(err.httpStatus).toBe(404);
    }
  });

  it("throws NotFoundError when parent_id points at a soft-deleted collection", async () => {
    const parentId = await seedChain(1);
    await driver
      .scoped(WORKSPACE_A)
      .updateTable("collections")
      .set({ deleted_at: 99 })
      .where("id", "=", parentId)
      .execute();
    const ctx = buildCtx(userPrincipal());
    await expect(
      collectionCreate.handler(ctx, { title: "under trashed", parent_id: parentId }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does NOT leave a collections row when parent validation fails (fail-fast)", async () => {
    const ctx = buildCtx(userPrincipal());
    await expect(
      collectionCreate.handler(ctx, { title: "orphan", parent_id: MISSING_COLLECTION }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("collections").selectAll().execute();
    // No orphan — the parent-not-found check fires before the INSERT.
    expect(rows).toHaveLength(0);
  });

  it("accepts a deep-but-under-cap parent chain", async () => {
    // parent at depth COLLECTION_MAX_DEPTH - 2 → new collection at
    // depth COLLECTION_MAX_DEPTH - 1 (deepest allowed).
    const deepParent = await seedChain(COLLECTION_MAX_DEPTH - 1);
    const ctx = buildCtx(userPrincipal());
    const out = await collectionCreate.handler(ctx, {
      title: "At cap",
      parent_id: deepParent,
    });
    expect(out.parent_id).toBe(deepParent);
  });

  it("rejects a depth that would exceed COLLECTION_MAX_DEPTH with ValidationError (400)", async () => {
    // parent at depth COLLECTION_MAX_DEPTH - 1 → new collection at
    // depth COLLECTION_MAX_DEPTH, which is refused.
    const capParent = await seedChain(COLLECTION_MAX_DEPTH);
    const ctx = buildCtx(userPrincipal());
    const err = await collectionCreate
      .handler(ctx, { title: "too deep", parent_id: capParent })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(err.httpStatus).toBe(400);
      const issues = err.issues as Array<{ code: string; path: readonly string[] }>;
      expect(issues[0]?.code).toBe("depth_cap_exceeded");
      expect(issues[0]?.path).toEqual(["parent_id"]);
    }
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("collections").selectAll().execute();
    // The pre-existing chain (n=COLLECTION_MAX_DEPTH) is there; no orphan from the rejected call.
    expect(rows.length).toBe(COLLECTION_MAX_DEPTH);
  });
});

// ── Slug collision (slice 2) ─────────────────────────────────────────────

describe("collection.create — sibling-slug pre-check", () => {
  it("throws SlugCollisionError when a root sibling already has the derived slug", async () => {
    const ctx = buildCtx(userPrincipal());
    await collectionCreate.handler(ctx, { title: "Foo" });
    await expect(collectionCreate.handler(ctx, { title: "foo" })).rejects.toBeInstanceOf(
      SlugCollisionError,
    );
  });

  it("throws SlugCollisionError when a nested sibling already has the derived slug", async () => {
    const ctx = buildCtx(userPrincipal());
    const parent = await collectionCreate.handler(ctx, { title: "Parent" });
    await collectionCreate.handler(ctx, {
      title: "Child",
      parent_id: parent.collection_id,
    });
    await expect(
      collectionCreate.handler(ctx, { title: "child", parent_id: parent.collection_id }),
    ).rejects.toBeInstanceOf(SlugCollisionError);
  });

  it("allows the same slug under a different parent (scope is sibling, not workspace)", async () => {
    const ctx = buildCtx(userPrincipal());
    const p1 = await collectionCreate.handler(ctx, { title: "P1" });
    const p2 = await collectionCreate.handler(ctx, { title: "P2" });
    const c1 = await collectionCreate.handler(ctx, {
      title: "Shared",
      parent_id: p1.collection_id,
    });
    const c2 = await collectionCreate.handler(ctx, {
      title: "Shared",
      parent_id: p2.collection_id,
    });
    expect(c1.slug).toBe("shared");
    expect(c2.slug).toBe("shared");
  });

  it("ignores soft-deleted siblings (slug can be reused)", async () => {
    const ctx = buildCtx(userPrincipal());
    const first = await collectionCreate.handler(ctx, { title: "Once" });
    // Soft-delete directly via the scoped handle (we don't need
    // `collection.delete` here — this test is isolated to the create
    // pre-check semantics).
    await driver
      .scoped(WORKSPACE_A)
      .updateTable("collections")
      .set({ deleted_at: 500 })
      .where("id", "=", first.collection_id)
      .execute();
    const replacement = await collectionCreate.handler(ctx, { title: "Once" });
    expect(replacement.slug).toBe("once");
  });

  it("error carries the derived slug + sibling scope (workspace root)", async () => {
    const ctx = buildCtx(userPrincipal());
    await collectionCreate.handler(ctx, { title: "Foo" });
    try {
      await collectionCreate.handler(ctx, { title: "Foo" });
      throw new Error("expected SlugCollisionError");
    } catch (err) {
      expect(err).toBeInstanceOf(SlugCollisionError);
      if (err instanceof SlugCollisionError) {
        expect(err.slug).toBe("foo");
        expect(err.parent_kind).toBe("workspace");
        expect(err.parent_id).toBeNull();
      }
    }
  });
});

// ── Agent attribution ────────────────────────────────────────────────────

// ── Space binding (ADR 0040 space-collection slice) ──────────────────────
//
// Root creates may request a `space_id` (existence-404 first, then
// `assertCanPlaceInSpace` standing); child creates INHERIT the parent's
// stored binding behind `assertCanPlaceIn`. The two Codex review pins
// live here: non-delegated agents do NOT ride the open-space user
// baseline, and child inheritance lands in the row + audit effect.

describe("collection.create — space binding", () => {
  const S_OPEN = SpaceId("018f0000-0000-7000-8000-0000000000e1");
  const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e2");
  const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e3");
  const S_GONE = SpaceId("018f0000-0000-7000-8000-0000000000e4"); // never inserted
  const C_SPACED = CollectionId("018f0000-0000-7000-8000-0000000000c4");
  const C_DANGLING = CollectionId("018f0000-0000-7000-8000-0000000000c5");
  const C_ANOM = CollectionId("018f0000-0000-7000-8000-0000000000c6");
  const G_SPACE = GrantId("018f0000-0000-7000-8000-0000000000f5");

  function bobPrincipal(): UserPrincipal {
    return { ...userPrincipal(), id: BOB };
  }

  async function seedSpaceRow(
    id: SpaceId,
    opts: { type?: "open" | "closed"; deleted_at?: number | null } = {},
  ) {
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("spaces")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        kind: "team",
        type: opts.type ?? "closed",
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

  async function seedSpaceMemberRow(space_id: SpaceId, user_id: UserId) {
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

  async function seedSpaceCollectionRow(id: CollectionId, space_id: SpaceId) {
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
        order_key: id,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }

  async function seedAgentSpaceGrant(space_id: SpaceId) {
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("grants")
      .values({
        id: G_SPACE,
        workspace_id: WORKSPACE_A,
        resource_kind: "space",
        resource_id: space_id,
        subject_kind: "agent",
        subject_id: AGENT_BOT42,
        role: "edit",
        is_guest: 0,
        created_by: ALICE,
        created_at: 7,
      })
      .execute();
  }

  it("root create with space_id binds the row + output when the user is a space member", async () => {
    await seedSpaceRow(S_CLOSED);
    await seedSpaceMemberRow(S_CLOSED, ALICE);
    const ctx = buildCtx(userPrincipal());
    const out = await collectionCreate.handler(ctx, { title: "Bound root", space_id: S_CLOSED });

    expect(out.parent_id).toBeNull();
    expect(out.space_id).toBe(S_CLOSED);
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", out.collection_id)
      .executeTakeFirstOrThrow();
    expect(row.space_id).toBe(S_CLOSED);
  });

  it("accepts explicit `parent_id: null` alongside space_id (root create, schema rail passes)", async () => {
    await seedSpaceRow(S_CLOSED);
    await seedSpaceMemberRow(S_CLOSED, ALICE);
    const parsed = collectionCreate.input.parse({
      title: "Explicit root",
      parent_id: null,
      space_id: S_CLOSED,
    });
    const out = await collectionCreate.handler(buildCtx(userPrincipal()), parsed);
    expect(out.space_id).toBe(S_CLOSED);
  });

  it("open space: a plain workspace user rides the open-space baseline", async () => {
    await seedSpaceRow(S_OPEN, { type: "open" });
    const ctx = buildCtx(bobPrincipal()); // not a space member, no grant
    const out = await collectionCreate.handler(ctx, { title: "Open root", space_id: S_OPEN });
    expect(out.space_id).toBe(S_OPEN);
  });

  it("Codex pin 1a: a non-delegated agent does NOT ride the open-space baseline (acl_deny, scope {space_id})", async () => {
    await seedSpaceRow(S_OPEN, { type: "open" });
    const ctx = buildCtx(agentPrincipal({ owner: ALICE })); // attribution ok, no space grant
    const err = await collectionCreate
      .handler(ctx, { title: "Agent open", space_id: S_OPEN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_OPEN } });
    }
  });

  it("Codex pin 1b: a delegated agent rides its delegator's open-space reach", async () => {
    await seedSpaceRow(S_OPEN, { type: "open" });
    const ctx = buildCtx(agentPrincipal({ owner: ALICE, acting_as: ALICE }));
    const out = await collectionCreate.handler(ctx, { title: "Delegated open", space_id: S_OPEN });
    expect(out.space_id).toBe(S_OPEN);
    expect(out.created_by).toBe(ALICE);
  });

  it("a non-delegated agent with an explicit space grant can create into a closed space", async () => {
    await seedSpaceRow(S_CLOSED);
    await seedAgentSpaceGrant(S_CLOSED);
    const ctx = buildCtx(agentPrincipal({ owner: ALICE }));
    const out = await collectionCreate.handler(ctx, { title: "Granted", space_id: S_CLOSED });
    expect(out.space_id).toBe(S_CLOSED);
  });

  it("missing space → NotFoundError (404) before any standing check", async () => {
    const ctx = buildCtx(userPrincipal());
    const err = await collectionCreate
      .handler(ctx, { title: "Ghost", space_id: S_GONE })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
      expect(err.subject_id).toBe(S_GONE);
    }
  });

  it("soft-deleted space → NotFoundError (404), same surface as missing", async () => {
    await seedSpaceRow(S_TRASHED, { deleted_at: 99 });
    const ctx = buildCtx(userPrincipal());
    await expect(
      collectionCreate.handler(ctx, { title: "Trashed", space_id: S_TRASHED }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("live closed space without membership or grant → acl_deny {space_id}", async () => {
    await seedSpaceRow(S_CLOSED);
    const ctx = buildCtx(bobPrincipal());
    const err = await collectionCreate
      .handler(ctx, { title: "No reach", space_id: S_CLOSED })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_CLOSED } });
    }
  });

  it("denied root create leaves no collections row (authority before insert)", async () => {
    await seedSpaceRow(S_CLOSED);
    await expect(
      collectionCreate.handler(buildCtx(bobPrincipal()), { title: "No row", space_id: S_CLOSED }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("collections").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("schema rail: `space_id` alongside a non-null `parent_id` is rejected at parse", () => {
    const result = collectionCreate.input.safeParse({
      title: "Both",
      parent_id: C_SPACED,
      space_id: S_CLOSED,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["space_id"]);
    }
    // Explicit-null space_id with a real parent is fine — null means
    // "no request", and the child inherits regardless.
    const ok = collectionCreate.input.safeParse({
      title: "Null space",
      parent_id: C_SPACED,
      space_id: null,
    });
    expect(ok.success).toBe(true);
  });

  it("Codex pin 2: a child under a space-bound parent INHERITS the binding — row, output, and audit effect", async () => {
    await seedSpaceRow(S_CLOSED);
    await seedSpaceMemberRow(S_CLOSED, ALICE);
    await seedSpaceCollectionRow(C_SPACED, S_CLOSED);
    const ctx = buildCtx(userPrincipal());
    const input = collectionCreate.input.parse({ title: "Inherited child", parent_id: C_SPACED });
    const out = await collectionCreate.handler(ctx, input);

    expect(out.parent_id).toBe(C_SPACED);
    expect(out.space_id).toBe(S_CLOSED); // derived, never supplied
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", out.collection_id)
      .executeTakeFirstOrThrow();
    expect(row.space_id).toBe(S_CLOSED);

    const effect = collectionCreate.audit.effectOnAllow(input, out);
    expect(effect.kind).toBe("collection.create");
    if (effect.kind === "collection.create") {
      expect(effect.space_id).toBe(S_CLOSED);
      expect(effect.parent_id).toBe(C_SPACED);
    }
  });

  it("child under a space-bound parent without reach → acl_deny {collection_id: parent}", async () => {
    await seedSpaceRow(S_CLOSED);
    await seedSpaceCollectionRow(C_SPACED, S_CLOSED);
    const ctx = buildCtx(bobPrincipal());
    const err = await collectionCreate
      .handler(ctx, { title: "Blocked child", parent_id: C_SPACED })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { collection_id: C_SPACED } });
    }
  });

  it("child under a DANGLING-space parent fails closed (anomaly), even for a space member elsewhere", async () => {
    await seedSpaceCollectionRow(C_DANGLING, S_GONE); // live collection, no spaces row
    const ctx = buildCtx(userPrincipal());
    const err = await collectionCreate
      .handler(ctx, { title: "Dangling child", parent_id: C_DANGLING })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { collection_id: C_DANGLING } });
    }
    // Inheritance can never copy the dangling ref into a fresh row.
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("collections").selectAll().execute();
    expect(rows).toHaveLength(1); // only the seeded parent
  });

  it("child under a TRASHED-space parent fails closed (anomaly, second arm)", async () => {
    await seedSpaceRow(S_TRASHED, { deleted_at: 99 });
    await seedSpaceCollectionRow(C_ANOM, S_TRASHED);
    const ctx = buildCtx(userPrincipal());
    await expect(
      collectionCreate.handler(ctx, { title: "Anomaly child", parent_id: C_ANOM }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("legacy root + legacy child remain reach-free (control: no spaces seeded at all)", async () => {
    const parentId = await seedChain(1);
    const ctx = buildCtx(bobPrincipal()); // no membership, no grants anywhere
    const root = await collectionCreate.handler(ctx, { title: "Legacy root" });
    expect(root.space_id).toBeNull();
    const child = await collectionCreate.handler(ctx, {
      title: "Legacy child",
      parent_id: parentId,
    });
    expect(child.space_id).toBeNull();
  });
});

describe("collection.create — agent principal attribution", () => {
  it("uses `acting_as` when set (delegated agent-auth token)", async () => {
    const principal = agentPrincipal({ owner: null, acting_as: BOB });
    const ctx = buildCtx(principal);
    const out = await collectionCreate.handler(ctx, { title: "Delegated" });
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", out.collection_id)
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBe(BOB);
    expect(out.created_by).toBe(BOB);
  });

  it("falls back to `owner_user_id` when `acting_as` is absent", async () => {
    const principal = agentPrincipal({ owner: ALICE });
    const ctx = buildCtx(principal);
    const out = await collectionCreate.handler(ctx, { title: "Owner-attributed" });
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", out.collection_id)
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBe(ALICE);
  });

  it("throws ValidationError for a workspace-owned agent (no owner, no delegation)", async () => {
    const principal = agentPrincipal({ owner: null });
    const ctx = buildCtx(principal);
    const err = await collectionCreate.handler(ctx, { title: "Orphan" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(err.httpStatus).toBe(400);
      expect(err.toHandlerError().kind).toBe("validation");
      const issues = err.issues as Array<{ code: string }>;
      expect(issues[0]?.code).toBe("unattributable_agent");
    }
  });

  it("does not leave a collections row when attribution fails", async () => {
    const principal = agentPrincipal({ owner: null });
    const ctx = buildCtx(principal);
    await expect(collectionCreate.handler(ctx, { title: "Orphan" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("collections").selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});

// ── Registry metadata + audit projections ─────────────────────────────────

describe("collection.create registry metadata", () => {
  it("declares the expected id, category, scope, surfaces, agentAllowed", () => {
    expect(collectionCreate.id).toBe("collection.create");
    expect(collectionCreate.category).toBe("mutation");
    expect(collectionCreate.requires).toEqual(["doc:write"]);
    expect(collectionCreate.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(collectionCreate.agentAllowed).toBeDefined();
  });
});

describe("collection.create audit projections", () => {
  const SAMPLE_COLLECTION_ID = CollectionId("018f0000-0000-7000-8000-0000000000d9");
  const SAMPLE_PARENT_ID = CollectionId("018f0000-0000-7000-8000-0000000000d1");
  const sampleOutput = {
    collection_id: SAMPLE_COLLECTION_ID,
    workspace_id: WORKSPACE_A,
    parent_id: SAMPLE_PARENT_ID,
    space_id: null,
    title: "T",
    slug: "t",
    order_key: "018f0000-0000-7000-8000-0000000000d9",
    created_by: ALICE,
  };

  it("effectOnAllow projects the collection.create audit kind with every field", () => {
    const effect = collectionCreate.audit.effectOnAllow({ title: "T" }, sampleOutput);
    expect(effect.kind).toBe("collection.create");
    if (effect.kind === "collection.create") {
      expect(effect.collection_id).toBe(SAMPLE_COLLECTION_ID);
      expect(effect.workspace_id).toBe(WORKSPACE_A);
      expect(effect.parent_id).toBe(SAMPLE_PARENT_ID);
      expect(effect.space_id).toBeNull();
      expect(effect.title).toBe("T");
      expect(effect.slug).toBe("t");
      expect(effect.order_key).toBe(sampleOutput.order_key);
      expect(effect.created_by).toBe(ALICE);
    }
  });

  it("effectOnAllow carries parent_id: null for root collections", () => {
    const effect = collectionCreate.audit.effectOnAllow(
      { title: "T" },
      { ...sampleOutput, parent_id: null },
    );
    if (effect.kind === "collection.create") {
      expect(effect.parent_id).toBeNull();
    }
  });

  it("subjectFrom returns the collection subject kind (no id before the handler runs)", () => {
    const subject = collectionCreate.audit.subjectFrom({ title: "T" });
    expect(subject.kind).toBe("collection");
  });

  it("effectOnDeny carries required_scopes + reason_code from the gate", () => {
    const effect = collectionCreate.audit.effectOnDeny(
      { title: "T" },
      { kind: "missing_scope", required: ["doc:write"], principal_scopes: ["doc:read"] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("collection.create");
      expect(effect.required_scopes).toEqual(["doc:write"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("effectOnError preserves the HandlerError kind (not flattened to internal)", () => {
    const effect = collectionCreate.audit.effectOnError(
      { title: "T" },
      { kind: "validation", issues: [] },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("collection.create");
      expect(effect.error_code).toBe("validation");
      expect(effect.retriable).toBe(false);
    }
  });

  it("effectOnError projects a non-retriable not_found when parent is missing", () => {
    const effect = collectionCreate.audit.effectOnError(
      { title: "T", parent_id: SAMPLE_PARENT_ID },
      { kind: "not_found", subject_kind: "collection", subject_id: SAMPLE_PARENT_ID },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("is non-collapsible — mutations always emit their own audit row", () => {
    expect(collectionCreate.audit.collapsePolicy.collapsible).toBe(false);
  });
});
