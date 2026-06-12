/**
 * `doc.create` — capability-level integration test.
 *
 * Runs the handler against a real in-memory SQLite driver and a real
 * `MemorySyncService` so the seed path actually touches a Y.Doc.
 * Cross-tenant isolation and the dispatcher's audit emission are owned
 * by their own tests; this file asserts only that `doc.create` composes
 * with those layers correctly.
 */

import type { SeedBlock } from "@editorzero/audit";
import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  DOCS_DDL,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { NotFoundError, SlugCollisionError, ValidationError } from "@editorzero/errors";
import {
  AgentId,
  BlockId,
  CollectionId,
  DocId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import { MemorySyncService, readBlocks } from "@editorzero/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docCreate } from "./create";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000a2");
const COLLECTION_C1 = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const AGENT_BOT42 = AgentId("018f0000-0000-7000-8000-0000000000f1");
const TOKEN = TokenId("018f0000-0000-7000-8000-0000000000e1");

let driver: SqliteDriver;
let sync: MemorySyncService;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  driver.exec(DOCS_DDL);
  sync = new MemorySyncService();
});

afterEach(async () => {
  await sync.close();
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
    transact: (doc_id, fn) => sync.transact(doc_id, fn),
    outbox: () => {
      /* doc.create emits no outbox events in v1 */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now,
  };
}

// ── Happy path ───────────────────────────────────────────────────────────

describe("doc.create handler", () => {
  it("mints a UUIDv7 doc_id, writes the docs row, seeds the Y.Doc with title+paragraph", async () => {
    const ctx = buildCtx(userPrincipal(), () => 42);
    const out = await docCreate.handler(ctx, { title: "Hello, World!" });

    // Output shape — workspace_id is the caller's scope; slug is kebab; order_key == doc_id.
    expect(out.workspace_id).toBe(WORKSPACE_A);
    expect(out.title).toBe("Hello, World!");
    expect(out.slug).toBe("hello-world");
    expect(out.access_mode).toBe("space");
    expect(out.published_slug).toBeNull();
    expect(out.published_at).toBeNull();
    expect(out.collection_id).toBeNull();
    expect(out.order_key).toBe(out.doc_id);
    // created_by is carried on the output so the audit effect can record it
    // (invariant 3a attribution — Codex review HIGH 1).
    expect(out.created_by).toBe(ALICE);
    // UUIDv7 parser asserts the shape: round-trip confirms branding.
    expect(DocId(out.doc_id)).toBe(out.doc_id);

    // docs row landed in the workspace.
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("docs").selectAll().execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.id).toBe(out.doc_id);
    expect(row.title).toBe("Hello, World!");
    expect(row.slug).toBe("hello-world");
    expect(row.access_mode).toBe("space");
    expect(row.published_slug).toBeNull();
    expect(row.published_at).toBeNull();
    expect(row.render_version).toBe(0);
    expect(row.created_by).toBe(ALICE);
    expect(row.created_at).toBe(42);
    expect(row.updated_at).toBe(42);
    expect(row.deleted_at).toBeNull();

    // Y.Doc was seeded with the canonical shape: heading/1 carrying
    // the title, followed by an empty paragraph.
    const blocks = await sync.transact(out.doc_id, (ydoc) => readBlocks(ydoc));
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph"]);
    const [heading] = blocks;
    if (heading === undefined) throw new Error("expected seeded heading block");
    expect(heading.content[0]?.text).toBe("Hello, World!");
  });

  it("lands new docs at workspace root, unpublished, with access_mode `space` (ADR 0040 Step 5)", async () => {
    // `access_mode` is intentionally not caller-settable — the mode
    // switch is the Step-8 ACL capability; see `create.ts` file
    // header. The handler hardcodes `access_mode: "space"`, a NULL
    // publish pair, and `collection_id: null` (when omitted), so a
    // fresh doc always presents that way regardless of what the
    // caller tried to supply.
    const ctx = buildCtx(userPrincipal());
    const out = await docCreate.handler(ctx, { title: "Plain notes" });
    expect(out.access_mode).toBe("space");
    expect(out.published_slug).toBeNull();
    expect(out.collection_id).toBeNull();

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.collection_id).toBeNull();
    expect(row.access_mode).toBe("space");
    expect(row.published_slug).toBeNull();
    expect(row.published_at).toBeNull();
  });

  it("rejects caller-supplied `access_mode` (and legacy `visibility`) at the input boundary", () => {
    // `InputSchema.strict()` emits a zod `unrecognized_keys` issue
    // for any field the schema doesn't know. That's how we refuse a
    // caller-chosen read scope before the grant machinery exists
    // (Codex F103 P1 lineage — a `"private"` doc nobody's ACL honours
    // yet would be false privacy). `access_mode` becomes accepted
    // input only via the Step-8 mode-switch capability, not here.
    // The retired `visibility` vocabulary must stay rejected too —
    // a pre-Step-5 client sending it deserves a 400, not silence.
    //
    // `collection_id` is accepted as of the collections-slice 1
    // widening (see `collection.create` sibling); the live-
    // collection check is exercised in the integration scenarios
    // below.
    for (const bad of [
      { title: "x", access_mode: "private" },
      { title: "x", access_mode: "space" },
      { title: "x", visibility: "public" },
      { title: "x", stray: 1 },
    ]) {
      const result = docCreate.input.safeParse(bad);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
      }
    }
  });

  it("rejects whitespace-only titles and trims surrounding whitespace on valid ones", async () => {
    // Codex F103 P2 #1 — `z.string().min(1)` on its own accepts
    // `"   "` and produces a doc whose stored title / heading
    // block render visually blank. `.trim().min(1)` closes the
    // hole: whitespace-only trims to empty and fails the non-empty
    // check; leading / trailing spaces on a real title strip
    // before storage so the heading renders clean.
    const blank = docCreate.input.safeParse({ title: "   " });
    expect(blank.success).toBe(false);
    if (!blank.success) {
      expect(blank.error.issues[0]?.path).toEqual(["title"]);
    }

    const alsoBlank = docCreate.input.safeParse({ title: "" });
    expect(alsoBlank.success).toBe(false);

    // Trimming: the zod schema strips surrounding whitespace so a
    // `"  Hello  "` request lands as `"Hello"` before the handler
    // ever sees it. The dispatcher runs `input.safeParse` ahead of
    // the handler, so we test the schema directly here (the unit
    // test calls `handler` with raw input and would skip the
    // transform otherwise).
    const parsed = docCreate.input.parse({ title: "  Hello  " });
    expect(parsed.title).toBe("Hello");

    const ctx = buildCtx(userPrincipal());
    const out = await docCreate.handler(ctx, parsed);
    expect(out.title).toBe("Hello");
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.title).toBe("Hello");
  });

  it("slugifies emoji / non-ASCII titles into kebab-case; falls back to `untitled`", async () => {
    const ctx = buildCtx(userPrincipal());
    const a = await docCreate.handler(ctx, { title: "Heading · with 🎉 mixed chars" });
    expect(a.slug).toBe("heading-with-mixed-chars");

    const b = await docCreate.handler(ctx, { title: "🎉🎊" });
    expect(b.slug).toBe("untitled");
  });

  it("pre-mints block IDs and threads them into both the Y.Doc and the output", async () => {
    // Invariant 3a (audit log reconstructs final state): the
    // `seed_blocks` field on the output must name the same block IDs
    // that actually land in the Y.XmlFragment. `seedBlocks` sets the
    // BlockNote `PartialBlock.id` field, which BlockNote's
    // `blockToNode` conversion honours when provided — regression test
    // in case a future BlockNote bump changes that behaviour. A replay
    // reducer that receives `{ kind: "doc.create", seed_blocks: [...]
    // }` and calls `seedBlocks(ydoc, seed_blocks)` then produces the
    // same Y.Doc state the original write did.
    const ctx = buildCtx(userPrincipal());
    const out = await docCreate.handler(ctx, { title: "ID thread-through" });

    expect(out.seed_blocks).toHaveLength(2);
    const [headingSeed, paragraphSeed] = out.seed_blocks;
    if (headingSeed === undefined || paragraphSeed === undefined) {
      throw new Error("expected two seed blocks in output");
    }
    expect(headingSeed.type).toBe("heading");
    expect(headingSeed.props).toEqual({ level: 1 });
    expect(headingSeed.content).toBe("ID thread-through");
    expect(paragraphSeed.type).toBe("paragraph");
    // UUIDv7 round-trip asserts the brand — no freshly-minted non-v7.
    expect(BlockId(headingSeed.id)).toBe(headingSeed.id);
    expect(BlockId(paragraphSeed.id)).toBe(paragraphSeed.id);

    // Y.Doc side: the blocks BlockNote wrote carry the same IDs the
    // audit row records.
    const blocks = await sync.transact(out.doc_id, (ydoc) => readBlocks(ydoc));
    expect(blocks).toHaveLength(2);
    const [heading, paragraph] = blocks;
    if (heading === undefined || paragraph === undefined) {
      throw new Error("expected two blocks in Y.Doc");
    }
    expect(heading.id).toBe(headingSeed.id);
    expect(paragraph.id).toBe(paragraphSeed.id);
  });

  it("generates a unique doc_id per call (uniqueness test against UUIDv7 generator)", async () => {
    const ctx = buildCtx(userPrincipal());
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const out = await docCreate.handler(ctx, { title: `Doc ${i}` });
      ids.add(out.doc_id);
    }
    expect(ids.size).toBe(10);
  });
});

// ── Optional collection_id ──────────────────────────────────────────────

describe("doc.create — optional collection_id", () => {
  async function seedCollection(id: typeof COLLECTION_C1, workspace_id: WorkspaceId) {
    await driver
      .scoped(workspace_id)
      .insertInto("collections")
      .values({
        id,
        workspace_id,
        parent_id: null,
        title: "C",
        slug: "c",
        order_key: id,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }

  it("places the new doc in a live collection when `collection_id` is supplied", async () => {
    await seedCollection(COLLECTION_C1, WORKSPACE_A);
    const ctx = buildCtx(userPrincipal());
    const out = await docCreate.handler(ctx, {
      title: "Scoped doc",
      collection_id: COLLECTION_C1,
    });
    expect(out.collection_id).toBe(COLLECTION_C1);

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .where("id", "=", out.doc_id)
      .executeTakeFirstOrThrow();
    expect(row.collection_id).toBe(COLLECTION_C1);
  });

  it("accepts an explicit `collection_id: null` as workspace root (same as omission)", async () => {
    const ctx = buildCtx(userPrincipal());
    const out = await docCreate.handler(ctx, { title: "Plain", collection_id: null });
    expect(out.collection_id).toBeNull();
  });

  it("throws NotFoundError when `collection_id` does not exist in the workspace", async () => {
    const ctx = buildCtx(userPrincipal());
    const err = await docCreate
      .handler(ctx, { title: "orphan", collection_id: COLLECTION_C1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("collection");
      expect(err.subject_id).toBe(COLLECTION_C1);
      expect(err.httpStatus).toBe(404);
    }
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("docs").selectAll().execute();
    // No orphan doc — fail-fast before INSERT.
    expect(rows).toHaveLength(0);
  });

  it("throws NotFoundError when `collection_id` is soft-deleted", async () => {
    await seedCollection(COLLECTION_C1, WORKSPACE_A);
    await driver
      .scoped(WORKSPACE_A)
      .updateTable("collections")
      .set({ deleted_at: 99 })
      .where("id", "=", COLLECTION_C1)
      .execute();
    const ctx = buildCtx(userPrincipal());
    await expect(
      docCreate.handler(ctx, { title: "into trashed", collection_id: COLLECTION_C1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cross-workspace isolation: a collection in workspace B is not reachable from workspace A", async () => {
    const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
    await seedCollection(COLLECTION_C1, WORKSPACE_B);
    const ctx = buildCtx(userPrincipal());
    // Same id, but the tenant plugin narrows the SELECT to workspace A.
    await expect(
      docCreate.handler(ctx, { title: "cross-ws", collection_id: COLLECTION_C1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Slug collision ─────────────────────────────────────────────────────────

describe("doc.create — slug collision", () => {
  // Local collection seeder (the sibling `seedCollection` lives in another
  // describe scope). Each gets a distinct slug so two roots never collide.
  async function seedCollection(id: CollectionId) {
    await driver
      .scoped(WORKSPACE_A)
      .insertInto("collections")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "C",
        slug: `c-${id.slice(-4)}`,
        order_key: id,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }

  it("throws SlugCollisionError when a root sibling already holds the derived slug", async () => {
    const ctx = buildCtx(userPrincipal());
    await docCreate.handler(ctx, { title: "Foo" });
    // "foo" slugifies to the same "foo" — collides with the first at root.
    const err = await docCreate.handler(ctx, { title: "foo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlugCollisionError);
    if (err instanceof SlugCollisionError) {
      expect(err.httpStatus).toBe(409);
      expect(err.code).toBe("slug_collision");
      expect(err.slug).toBe("foo");
      expect(err.parent_kind).toBe("workspace");
      expect(err.parent_id).toBeNull();
    }
    // Fail-fast before the INSERT — no second row landed.
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("docs").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it("throws SlugCollisionError when a collection-nested sibling holds the derived slug", async () => {
    await seedCollection(COLLECTION_C1);
    const ctx = buildCtx(userPrincipal());
    await docCreate.handler(ctx, { title: "Note", collection_id: COLLECTION_C1 });
    const err = await docCreate
      .handler(ctx, { title: "note", collection_id: COLLECTION_C1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlugCollisionError);
    if (err instanceof SlugCollisionError) {
      expect(err.parent_kind).toBe("collection");
      expect(err.parent_id).toBe(COLLECTION_C1);
    }
  });

  it("allows the same slug at workspace root and inside a collection (NULL-aware scope)", async () => {
    await seedCollection(COLLECTION_C1);
    const ctx = buildCtx(userPrincipal());
    const root = await docCreate.handler(ctx, { title: "Shared" });
    const nested = await docCreate.handler(ctx, { title: "Shared", collection_id: COLLECTION_C1 });
    expect(root.slug).toBe("shared");
    expect(nested.slug).toBe("shared");
    expect(root.collection_id).toBeNull();
    expect(nested.collection_id).toBe(COLLECTION_C1);
  });

  it("allows the same slug under two different collections (scope is sibling, not workspace)", async () => {
    const C2 = CollectionId("018f0000-0000-7000-8000-0000000000c2");
    await seedCollection(COLLECTION_C1);
    await seedCollection(C2);
    const ctx = buildCtx(userPrincipal());
    const a = await docCreate.handler(ctx, { title: "Dup", collection_id: COLLECTION_C1 });
    const b = await docCreate.handler(ctx, { title: "Dup", collection_id: C2 });
    expect(a.slug).toBe("dup");
    expect(b.slug).toBe("dup");
  });

  it("ignores soft-deleted siblings — the slug can be reused", async () => {
    const ctx = buildCtx(userPrincipal());
    const first = await docCreate.handler(ctx, { title: "Recyclable" });
    await driver
      .scoped(WORKSPACE_A)
      .updateTable("docs")
      .set({ deleted_at: 99 })
      .where("id", "=", first.doc_id)
      .execute();
    // The pre-check SELECT filters `deleted_at IS NULL`, matching the
    // partial index — a trashed sibling no longer reserves the slug.
    const second = await docCreate.handler(ctx, { title: "Recyclable" });
    expect(second.slug).toBe("recyclable");
    expect(second.doc_id).not.toBe(first.doc_id);
  });
});

// ── Agent attribution ────────────────────────────────────────────────────

describe("doc.create — agent principal attribution", () => {
  it("uses `acting_as` when set (agent-auth delegated token)", async () => {
    const principal = agentPrincipal({ owner: null, acting_as: BOB });
    const ctx = buildCtx(principal);
    const out = await docCreate.handler(ctx, { title: "Delegated write" });

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .executeTakeFirstOrThrow();
    // Delegator (BOB) is the attribution target, not the agent — on both the
    // persisted row and the output the audit effect reads from.
    expect(row.created_by).toBe(BOB);
    expect(out.created_by).toBe(BOB);
    expect(out.title).toBe("Delegated write");
  });

  it("falls back to `owner_user_id` when `acting_as` is absent", async () => {
    const principal = agentPrincipal({ owner: ALICE });
    const ctx = buildCtx(principal);
    await docCreate.handler(ctx, { title: "Owner-attributed" });

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBe(ALICE);
  });

  it("throws ValidationError for an agent with no owner and no delegation (400 on the surface)", async () => {
    const principal = agentPrincipal({ owner: null });
    const ctx = buildCtx(principal);
    const err = await docCreate.handler(ctx, { title: "Orphan" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      // `httpStatus: 400` means adapters surface this as a client error,
      // not a 500. The dispatcher's audit projection is
      // `{ kind: "validation" }` (per `toHandlerError`), not `"internal"`.
      expect(err.httpStatus).toBe(400);
      expect(err.toHandlerError().kind).toBe("validation");
      // Issues payload carries a machine-readable code so surfaces can
      // render / classify the refusal without string-matching the
      // message.
      const issues = err.issues as Array<{ code: string }>;
      expect(issues[0]?.code).toBe("unattributable_agent");
    }
  });

  it("does not leave a docs row when attribution fails (fail-fast before any write)", async () => {
    // `resolveCreatedBy` throws before either the docs INSERT or the
    // `ctx.transact` seed runs. No partial state lands regardless of
    // ordering or whether a dispatcher tx is in scope.
    const principal = agentPrincipal({ owner: null });
    const ctx = buildCtx(principal);
    await expect(docCreate.handler(ctx, { title: "Orphan" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const rows = await driver.scoped(WORKSPACE_A).selectFrom("docs").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  // The "orphan docs row on seed failure" invariant moved from in-
  // handler ordering (seed-first, insert-second) to the dispatcher's
  // write-path tx (P3.6b) once the CRDT persist started going through
  // SQL via `DocUpdatesWriter` (P3.6c). `doc.create` now runs
  // insert-first, seed-second; a `ctx.transact` failure rolls back the
  // whole tx including the `docs` INSERT. That atomicity is covered by
  // `packages/dispatcher/src/writepath.integration.test.ts`; pinning
  // it here with a stubbed `transact` would just assert the stub, not
  // the production invariant.
});

// ── Registry metadata + audit projections ─────────────────────────────────

describe("doc.create registry metadata", () => {
  it("declares the expected id, category, scope, surfaces, agentAllowed", () => {
    expect(docCreate.id).toBe("doc.create");
    expect(docCreate.category).toBe("mutation");
    expect(docCreate.requires).toEqual(["doc:write"]);
    // "ui" since the docs panel's "+ New doc" form landed (proven by the
    // marked Playwright spec in packages/e2e — ADR 0040 H11).
    expect(docCreate.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(docCreate.agentAllowed).toBeDefined();
  });
});

describe("doc.create audit projections", () => {
  const SAMPLE_HEADING_ID = BlockId("018f0000-0000-7000-8000-0000000000b1");
  const SAMPLE_PARAGRAPH_ID = BlockId("018f0000-0000-7000-8000-0000000000b2");
  const sampleSeedBlocks: SeedBlock[] = [
    { id: SAMPLE_HEADING_ID, type: "heading", props: { level: 1 }, content: "T" },
    { id: SAMPLE_PARAGRAPH_ID, type: "paragraph", content: "" },
  ];
  const sampleOutput = {
    doc_id: DocId("018f0000-0000-7000-8000-0000000000d9"),
    workspace_id: WORKSPACE_A,
    collection_id: COLLECTION_C1,
    title: "T",
    slug: "t",
    order_key: "018f0000-0000-7000-8000-0000000000d9",
    created_by: ALICE,
    access_mode: "space" as const,
    published_slug: null,
    published_at: null,
    seed_blocks: sampleSeedBlocks,
  };

  it("effectOnAllow projects the doc.create audit kind with every field", () => {
    const effect = docCreate.audit.effectOnAllow({ title: "T" }, sampleOutput);
    expect(effect.kind).toBe("doc.create");
    if (effect.kind === "doc.create") {
      expect(effect.doc_id).toBe(sampleOutput.doc_id);
      expect(effect.workspace_id).toBe(WORKSPACE_A);
      expect(effect.collection_id).toBe(COLLECTION_C1);
      expect(effect.title).toBe("T");
      expect(effect.slug).toBe("t");
      expect(effect.order_key).toBe(sampleOutput.order_key);
      expect(effect.created_by).toBe(ALICE);
      expect(effect.access_mode).toBe("space");
      // Invariant 3a: pre-minted block IDs land in the audit envelope
      // so a later replay can reconstruct the initial Y.Doc fragment.
      expect(effect.seed_blocks).toEqual(sampleSeedBlocks);
    }
  });

  it("subjectFrom returns the doc subject kind (no id before the handler runs)", () => {
    const subject = docCreate.audit.subjectFrom({ title: "T" });
    expect(subject.kind).toBe("doc");
  });

  it("effectOnDeny carries required_scopes + reason_code from the gate", () => {
    const effect = docCreate.audit.effectOnDeny(
      { title: "T" },
      { kind: "missing_scope", required: ["doc:write"], principal_scopes: ["doc:read"] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.create");
      expect(effect.required_scopes).toEqual(["doc:write"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("effectOnError preserves the HandlerError kind — validation is not flattened to internal", () => {
    // Before F102's `projectErrorAudit` helper, `effectOnError`
    // hard-coded `error_code: "internal"` regardless of the thrown
    // shape. That misclassified every `ValidationError` (400-class,
    // client-retriable-after-input-fix) as a server error in the
    // audit log — Codex P2 finding. This assertion pins the fix.
    const effect = docCreate.audit.effectOnError(
      { title: "T" },
      { kind: "validation", issues: [] },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.create");
      expect(effect.error_code).toBe("validation");
      expect(effect.retriable).toBe(false);
    }
  });

  it("effectOnError projects a non-retriable internal error for unknown-origin throws", () => {
    const effect = docCreate.audit.effectOnError(
      { title: "T" },
      { kind: "internal", trace_id: "" },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.create");
      expect(effect.error_code).toBe("internal");
      expect(effect.retriable).toBe(false);
    }
  });

  it("effectOnError marks conflict + upstream as retriable (CLI / client auto-retry signal)", () => {
    const conflict = docCreate.audit.effectOnError({ title: "T" }, { kind: "conflict" });
    expect(conflict.kind === "error" && conflict.retriable).toBe(true);

    const upstream = docCreate.audit.effectOnError(
      { title: "T" },
      { kind: "upstream", service: "storage", status: 502 },
    );
    expect(upstream.kind === "error" && upstream.retriable).toBe(true);
  });

  it("is non-collapsible — mutations always emit their own audit row", () => {
    expect(docCreate.audit.collapsePolicy.collapsible).toBe(false);
  });
});
