/**
 * Write-path tx primitive — rollback semantics (P3.6b).
 *
 * ADR 0018 / F31: the dispatcher owns a single SQL transaction that
 * commits handler DB writes + the allow audit row atomically. Handler
 * error / output-validation failure / post-parse deny must roll back
 * the handler's DB writes, while the audit row for the failed
 * invocation still persists in a separate short-lived tx.
 *
 * These tests wire the dispatcher against a real in-memory SQLite
 * driver + a real audit writer that INSERTs into `audit_events` via
 * the opaque `AuditTx` handle. Each scenario observes the database
 * post-invocation to verify the tx boundary behaved as specified.
 *
 * The "write-path tx" covered here is handler-db-writes + audit; the
 * Hocuspocus-backed `doc_updates` write lands in P3.6c. The tx shape
 * generalises to the full `doc_updates + outbox + audit_events +
 * outbox` tuple once Hocuspocus's DB-tx hook is wired in.
 */

import {
  type Capability,
  type CapabilityContext,
  createRegistry,
  registerCapability,
} from "@editorzero/capabilities";
import {
  asAuditTx,
  createSqliteAuditWriter,
  createSqliteDocUpdatesWriter,
  createSqliteDriver,
  createTenantScopedDb,
  FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { PermissionDeniedError } from "@editorzero/errors";
import { CapabilityId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AccessPath, UserPrincipal } from "@editorzero/principal";
import { HocuspocusSync } from "@editorzero/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { z } from "zod";
import type { CapabilityContextExtras } from "./index";
import { createDispatcher, scopeOnlyGate } from "./index";

// ── Fixtures ──────────────────────────────────────────────────────────────

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_INSERT_ID = CapabilityId("doc.insert_fixture");
const DOC_COUNT_ID = CapabilityId("doc.count_fixture");

const DOC_ID_A = DocId("018f0000-0000-7000-8000-0000000000a1");

interface DocInsertInput {
  readonly doc_id: string;
  readonly title: string;
}
interface DocInsertOutput {
  readonly doc_id: string;
  readonly title: string;
}

type DocCountInput = Record<string, never>;
interface DocCountOutput {
  readonly count: number;
}

let driver: SqliteDriver;
let hocuspocus: HocuspocusSync | null = null;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(FULL_DDL);
  hocuspocus = null;
});

afterEach(async () => {
  if (hocuspocus !== null) await hocuspocus.close();
  await driver.close();
});

function testUser(): UserPrincipal {
  return {
    kind: "user",
    id: USER_ID,
    workspace_id: WORKSPACE_ID,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function testAccess(): AccessPath {
  return { workspace_id: WORKSPACE_ID };
}

/**
 * Build a capability whose handler INSERTs into `docs` through the
 * tx-scoped `ctx.db`. Body is injected per test — allow / throw /
 * shape-violation / post-parse-deny — so the only thing that varies
 * across scenarios is what the handler does *after* the insert, not
 * the insert itself.
 */
function buildDocInsertCapability(
  bodyAfterInsert: (ctx: CapabilityContext, input: DocInsertInput) => Promise<DocInsertOutput>,
  overrides: Partial<Pick<Capability<DocInsertInput, DocInsertOutput>, "requires">> = {},
): Capability<DocInsertInput, DocInsertOutput> {
  return {
    id: DOC_INSERT_ID,
    category: "mutation",
    summary: "integration fixture: insert into docs",
    input: z.object({ doc_id: z.string(), title: z.string() }),
    output: z.object({ doc_id: z.string(), title: z.string() }),
    requires: overrides.requires ?? ["doc:write"],
    audit: {
      subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
      effectOnAllow: (input) => ({
        kind: "doc.rename",
        doc_id: DocId(input.doc_id),
        title: input.title,
      }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: DOC_INSERT_ID,
        required_scopes: ["doc:write"],
        // Mirror the internal `DenyReason.kind` into the public
        // `reason_code` — same convention as real capabilities
        // (see `packages/capabilities/src/doc/create.ts`). Audit-writer
        // denormalises the indexed `deny_reason` column from
        // `effect.reason_code` so the two stay aligned.
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: DOC_INSERT_ID,
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler: async (ctx, input) => {
      // `workspace_id` is listed in `.values` to satisfy Kysely's
      // typed INSERT shape; the `WorkspaceScopingPlugin` asserts it
      // matches `principal.workspace_id` (F86 + F87) — disagreement
      // throws `TenantScopeViolationError`.
      await ctx.db
        .insertInto("docs")
        .values({
          id: DocId(input.doc_id),
          workspace_id: ctx.tenant.workspace_id,
          collection_id: null,
          title: input.title,
          slug: input.doc_id,
          order_key: "m",
          visibility: "workspace",
          visibility_version: 0,
          created_by: USER_ID,
          created_at: Date.now(),
          updated_at: Date.now(),
          deleted_at: null,
        })
        .execute();
      return bodyAfterInsert(ctx, input);
    },
  };
}

/**
 * Build a `category: "read"` fixture capability that COUNTs the `docs`
 * table via `ctx.db`. Used to prove reads route through `runRead` —
 * they don't open a write-path tx, so concurrent writers are not
 * blocked on the RESERVED lock that `BEGIN IMMEDIATE` would hold.
 */
function buildDocCountCapability(): Capability<DocCountInput, DocCountOutput> {
  return {
    id: DOC_COUNT_ID,
    category: "read",
    summary: "integration fixture: count docs",
    input: z.object({}).strict() as unknown as z.ZodType<DocCountInput>,
    output: z.object({ count: z.number() }),
    requires: ["doc:read"],
    audit: {
      subjectFrom: () => ({ kind: "doc" }),
      effectOnAllow: () => ({ kind: "audit.access_log" }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: DOC_COUNT_ID,
        required_scopes: ["doc:read"],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: DOC_COUNT_ID,
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler: async (ctx) => {
      const rows = await ctx.db
        .selectFrom("docs")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .execute();
      return { count: rows[0]?.n ?? 0 };
    },
  };
}

interface RunnerCounts {
  writeTx: number;
  read: number;
}

function mountDispatcher<I, O>(capability: Capability<I, O>) {
  const registry = createRegistry([registerCapability(capability)]);
  const auditWriter = createSqliteAuditWriter();
  const runners: RunnerCounts = { writeTx: 0, read: 0 };
  let tick = 0;
  const dispatcher = createDispatcher({
    registry,
    gate: scopeOnlyGate(),
    auditWriter,
    tracer: noopTracer,
    logger: noopLogger,
    now: () => {
      tick += 1;
      return tick;
    },
    runInWriteTx: async (principal, fn) => {
      runners.writeTx += 1;
      return driver.withSystemTx(async (tx) => {
        const extras: CapabilityContextExtras = {
          db: createTenantScopedDb(tx, principal.workspace_id),
          outbox: () => {
            /* P3.6b: outbox writes deferred to P3.6c */
          },
          transact: async () => {
            throw new Error("transact unused in P3.6b write-path tests");
          },
        };
        return fn(extras, asAuditTx(tx));
      });
    },
    // Reads stay out of `runInWriteTx` to avoid taking the RESERVED
    // lock `BEGIN IMMEDIATE` would grab (§6.4). The read handle is a
    // plain tenant-scoped wrapper over the base Kysely — WAL mode lets
    // it run concurrently with writers.
    runRead: async (principal, fn) => {
      runners.read += 1;
      const extras: CapabilityContextExtras = {
        db: driver.scoped(principal.workspace_id),
        outbox: () => {
          /* reads do not emit */
        },
        transact: async () => {
          throw new Error("reads must not call ctx.transact");
        },
      };
      return fn(extras);
    },
    withAuditTx: (fn) => driver.withSystemTx((tx) => fn(asAuditTx(tx))),
  });
  return { dispatcher, runners };
}

async function countDocs(): Promise<number> {
  const rows = await driver
    .system()
    .selectFrom("docs")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .execute();
  return rows[0]?.n ?? 0;
}

async function fetchAuditEvents(): Promise<
  Array<{ outcome: string; deny_reason: string | null; capability_id: string }>
> {
  return driver
    .system()
    .selectFrom("audit_events")
    .select(["outcome", "deny_reason", "capability_id"])
    .execute();
}

async function fetchDocUpdates(
  doc_id: DocId,
): Promise<Array<{ seq: number; update_blob: Uint8Array }>> {
  return driver
    .system()
    .selectFrom("doc_updates")
    .select(["seq", "update_blob"])
    .where("doc_id", "=", doc_id)
    .orderBy("seq", "asc")
    .execute();
}

async function fetchOutbox(): Promise<Array<{ event: string; payload: string }>> {
  return driver.system().selectFrom("outbox").select(["event", "payload"]).execute();
}

async function seedExistingDoc(doc_id: DocId): Promise<void> {
  // Pre-seed only the `docs` row — stand-in for `doc.create`'s handler
  // INSERT (already exercised in the SQL-only tests above). The
  // `DocUpdatesWriter` auto-bootstraps `doc_counters` on first write
  // via ON CONFLICT DO NOTHING, so the content-mutation fixtures below
  // don't need a separate priming step. The FK
  // `doc_counters.doc_id REFERENCES docs(id)` enforces the docs-first
  // order the real pipeline preserves (writer hits the FK if the docs
  // row is missing — same shape we assert for raw
  // `HocuspocusSync.transact` in the sync integration tests).
  const now = Date.now();
  await driver
    .system()
    .insertInto("docs")
    .values({
      id: doc_id,
      workspace_id: WORKSPACE_ID,
      collection_id: null,
      title: "seed",
      slug: "seed",
      order_key: "a",
      visibility: "workspace",
      visibility_version: 0,
      created_by: USER_ID,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    .execute();
}

// ── Content-mutation fixture (P3.6c) ─────────────────────────────────────
//
// Capability that exercises the full content-mutation write path:
// (1) UPDATEs the existing `docs` row via `ctx.db`, (2) calls
// `ctx.transact(doc_id, fn)` to mutate the Y.Doc — the writer auto-
// bootstraps `doc_counters` on first write. A variant
// `bodyAfterTransact` injects allow / throw / output-violation
// behaviours — mirroring the `buildDocInsertCapability` shape for the
// SQL-only write-path tests above.

const DOC_MUTATE_ID = CapabilityId("doc.mutate_fixture");

interface DocMutateInput {
  readonly doc_id: string;
  readonly text: string;
}
interface DocMutateOutput {
  readonly doc_id: string;
  readonly text: string;
}

function buildDocMutateCapability(
  bodyAfterTransact: (ctx: CapabilityContext, input: DocMutateInput) => Promise<DocMutateOutput>,
  overrides: Partial<Pick<Capability<DocMutateInput, DocMutateOutput>, "requires">> = {},
): Capability<DocMutateInput, DocMutateOutput> {
  return {
    id: DOC_MUTATE_ID,
    category: "mutation",
    summary: "integration fixture: open ctx.transact + write Y.Doc text",
    input: z.object({ doc_id: z.string(), text: z.string() }),
    output: z.object({ doc_id: z.string(), text: z.string() }),
    requires: overrides.requires ?? ["doc:write"],
    audit: {
      subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
      effectOnAllow: (input) => ({
        kind: "doc.rename",
        doc_id: DocId(input.doc_id),
        title: input.text,
      }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: DOC_MUTATE_ID,
        required_scopes: ["doc:write"],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: DOC_MUTATE_ID,
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler: async (ctx, input) => {
      // Metadata-side write: bump the `updated_at` on the existing
      // `docs` row via `ctx.db`. Tenant-scoping plugin enforces
      // `workspace_id` = principal's workspace (F86 + F87). The write
      // is in the same tx as the `ctx.transact` call below; an update
      // here verifies that metadata mutations and CRDT mutations
      // commit atomically.
      await ctx.db
        .updateTable("docs")
        .set({ title: input.text, updated_at: Date.now() })
        .where("id", "=", DocId(input.doc_id))
        .execute();
      // CRDT content mutation through `ctx.transact`. Writes one
      // `doc_updates` row + one `outbox(doc.updated)` row via the
      // sync package's bound writer — inside the same SQL tx the
      // dispatcher opened for the `docs` UPDATE above. The
      // `doc_counters` row auto-bootstraps on this first write (ON
      // CONFLICT DO NOTHING inside the writer); no external priming
      // step is needed.
      await ctx.transact(DocId(input.doc_id), (editor) => {
        (editor as unknown as Y.Doc).getText("body").insert(0, input.text);
      });
      return bodyAfterTransact(ctx, input);
    },
  };
}

interface ContentMountResult {
  dispatcher: ReturnType<typeof createDispatcher>;
  runners: RunnerCounts;
  hocuspocus: HocuspocusSync;
}

function mountContentDispatcher<I, O>(capability: Capability<I, O>): ContentMountResult {
  const registry = createRegistry([registerCapability(capability)]);
  const auditWriter = createSqliteAuditWriter();
  const docUpdatesWriter = createSqliteDocUpdatesWriter();
  const sync = new HocuspocusSync({ docUpdatesWriter });
  hocuspocus = sync;
  const runners: RunnerCounts = { writeTx: 0, read: 0 };
  let tick = 0;
  const dispatcher = createDispatcher({
    registry,
    gate: scopeOnlyGate(),
    auditWriter,
    tracer: noopTracer,
    logger: noopLogger,
    now: () => {
      tick += 1;
      return tick;
    },
    runInWriteTx: async (principal, fn) => {
      runners.writeTx += 1;
      return driver.withSystemTx(async (tx) => {
        const auditTx = asAuditTx(tx);
        // `hocuspocus.bind(ctx)` hands back a tx-bound `SyncService`
        // whose `transact` closes over `auditTx` so the
        // `DocUpdatesWriter.write` call commits inside the same SQL
        // tx as the handler's `ctx.db` writes and the allow audit
        // row. One `bind` per dispatcher invocation.
        const bound = sync.bind({
          sqlTx: auditTx,
          principal,
          workspace_id: principal.workspace_id,
        });
        const extras: CapabilityContextExtras = {
          db: createTenantScopedDb(tx, principal.workspace_id),
          outbox: () => {
            /* handler-emitted outbox rows land in P3.6d */
          },
          transact: bound.transact.bind(bound),
        };
        return fn(extras, auditTx);
      });
    },
    runRead: async (principal, fn) => {
      runners.read += 1;
      const extras: CapabilityContextExtras = {
        db: driver.scoped(principal.workspace_id),
        outbox: () => {
          /* reads do not emit */
        },
        transact: async () => {
          throw new Error("reads must not call ctx.transact");
        },
      };
      return fn(extras);
    },
    withAuditTx: (fn) => driver.withSystemTx((tx) => fn(asAuditTx(tx))),
  });
  return { dispatcher, runners, hocuspocus: sync };
}

// ── Scenarios ─────────────────────────────────────────────────────────────

describe("write-path tx primitive (F31)", () => {
  it("allow: handler docs INSERT + audit row commit together", async () => {
    const { dispatcher } = mountDispatcher(
      buildDocInsertCapability(async (_ctx, input) => ({
        doc_id: input.doc_id,
        title: input.title,
      })),
    );

    await dispatcher.dispatch({
      capability_id: DOC_INSERT_ID,
      input: { doc_id: DOC_ID_A, title: "hello" },
      principal: testUser(),
      access: testAccess(),
      trace_id: null,
    });

    expect(await countDocs()).toBe(1);
    const rows = await fetchAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("allow");
  });

  it("handler throws: docs INSERT rolls back; error audit still persists", async () => {
    const { dispatcher } = mountDispatcher(
      buildDocInsertCapability(async () => {
        throw new Error("handler boom");
      }),
    );

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_INSERT_ID,
        input: { doc_id: DOC_ID_A, title: "hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(Error);

    // Rollback: the handler's `docs` INSERT is gone.
    expect(await countDocs()).toBe(0);
    // The error-audit tx is separate and commits.
    const rows = await fetchAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
  });

  it("output shape violation: docs INSERT rolls back; error audit persists", async () => {
    const { dispatcher } = mountDispatcher(
      buildDocInsertCapability(
        // Return value that zod's output schema rejects. Typed escape
        // keeps this explicit about intent (no inadvertent `any` leak
        // in test helpers).
        // biome-ignore lint/suspicious/noExplicitAny: handler invariant test.
        (async (): Promise<any> => ({ doc_id: "abc" /* missing title */ })) as never,
      ),
    );

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_INSERT_ID,
        input: { doc_id: DOC_ID_A, title: "hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(await countDocs()).toBe(0);
    const rows = await fetchAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
  });

  it("post-parse deny: docs INSERT rolls back; deny audit persists", async () => {
    const { dispatcher } = mountDispatcher(
      buildDocInsertCapability(async () => {
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { doc_id: DocId(DOC_ID_A) } },
        });
      }),
    );

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_INSERT_ID,
        input: { doc_id: DOC_ID_A, title: "hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    expect(await countDocs()).toBe(0);
    const rows = await fetchAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("deny");
    expect(rows[0]?.deny_reason).toBe("acl_deny");
  });

  it("gate deny: handler never runs; deny audit persists", async () => {
    const { dispatcher } = mountDispatcher(
      buildDocInsertCapability(
        async (_ctx, input) => ({ doc_id: input.doc_id, title: input.title }),
        { requires: ["workspace:admin"] },
      ),
    );

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_INSERT_ID,
        input: { doc_id: DOC_ID_A, title: "hello" },
        principal: { ...testUser(), roles: ["guest"] },
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    expect(await countDocs()).toBe(0);
    const rows = await fetchAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("deny");
    expect(rows[0]?.deny_reason).toBe("missing_scope");
  });

  it("input validation: handler never runs; error audit persists", async () => {
    const { dispatcher } = mountDispatcher(
      buildDocInsertCapability(async (_ctx, input) => ({
        doc_id: input.doc_id,
        title: input.title,
      })),
    );

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_INSERT_ID,
        input: { doc_id: 123, title: "hello" }, // doc_id not a string
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(await countDocs()).toBe(0);
    const rows = await fetchAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
  });

  it("read: routes through runRead (not runInWriteTx); handler query returns; allow audit persists", async () => {
    // Seed a row so the count is non-zero — proves the read handle is
    // tenant-scoped over the same DB the mutation path writes into.
    await driver
      .system()
      .insertInto("docs")
      .values({
        id: DOC_ID_A,
        workspace_id: WORKSPACE_ID,
        collection_id: null,
        title: "seed",
        slug: "seed",
        order_key: "a",
        visibility: "workspace",
        visibility_version: 0,
        created_by: USER_ID,
        created_at: Date.now(),
        updated_at: Date.now(),
        deleted_at: null,
      })
      .execute();

    const { dispatcher, runners } = mountDispatcher(buildDocCountCapability());

    const out = await dispatcher.dispatch({
      capability_id: DOC_COUNT_ID,
      input: {},
      principal: testUser(),
      access: testAccess(),
      trace_id: null,
    });

    expect(out).toEqual({ count: 1 });
    // Direct behavioural assertion on the branch: reads go through
    // `runRead`, never through `runInWriteTx`. A regression that
    // re-routes reads into the write-path tx would flip these numbers
    // and re-introduce the RESERVED-lock contention Codex flagged.
    expect(runners.read).toBe(1);
    expect(runners.writeTx).toBe(0);
    // Allow audit still lands — `withAuditTx` opens its own
    // short-lived tx for the row.
    const rows = await fetchAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("allow");
    expect(rows[0]?.capability_id).toBe(DOC_COUNT_ID);
  });
});

// ── P3.6c: content-mutation atomicity (invariant 7 end-to-end) ────────────
//
// Closes the atomicity window ADR 0018 F31 opened. A capability that
// calls `ctx.transact` must commit its CRDT write (`doc_updates` +
// `outbox(doc.updated)`) in the SAME SQL tx as its metadata writes
// (`docs` INSERT) and the dispatcher's `allow` audit row. Handler
// throw after `ctx.transact` → entire tuple rolls back.

describe("write-path tx + content mutation (P3.6c)", () => {
  it("allow: docs UPDATE + doc_updates + outbox + audit row commit atomically", async () => {
    const { dispatcher } = mountContentDispatcher(
      buildDocMutateCapability(async (_ctx, input) => ({
        doc_id: input.doc_id,
        text: input.text,
      })),
    );
    await seedExistingDoc(DocId(DOC_ID_A));

    await dispatcher.dispatch({
      capability_id: DOC_MUTATE_ID,
      input: { doc_id: DOC_ID_A, text: "hello" },
      principal: testUser(),
      access: testAccess(),
      trace_id: null,
    });

    // Docs row updated (pre-seeded `title = "seed"`, now "hello").
    const docRow = await driver
      .system()
      .selectFrom("docs")
      .select("title")
      .where("id", "=", DocId(DOC_ID_A))
      .executeTakeFirstOrThrow();
    expect(docRow.title).toBe("hello");
    const updates = await fetchDocUpdates(DocId(DOC_ID_A));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.seq).toBe(1);
    expect(updates[0]?.update_blob.length).toBeGreaterThan(0);

    const outbox = await fetchOutbox();
    // One `doc.updated` row from the sync writer. `audit.appended`
    // landing in the same tx is P3.6d's dispatcher-side addition;
    // until then the outbox has exactly one row.
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event).toBe("doc.updated");

    const audit = await fetchAuditEvents();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe("allow");
    expect(audit[0]?.capability_id).toBe(DOC_MUTATE_ID);
  });

  it("handler throws after ctx.transact: docs UPDATE + doc_updates + outbox all roll back; error audit persists", async () => {
    const { dispatcher } = mountContentDispatcher(
      buildDocMutateCapability(async () => {
        // Thrown AFTER `ctx.transact` succeeded — the stored update
        // blob must not leak into `doc_updates` outside the
        // committed window.
        throw new Error("handler boom after transact");
      }),
    );
    await seedExistingDoc(DocId(DOC_ID_A));

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_MUTATE_ID,
        input: { doc_id: DOC_ID_A, text: "hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toThrow(/boom after transact/);

    // Docs pre-seeded title was "seed"; the handler's UPDATE inside
    // the tx should have been rolled back. `countDocs` still 1 (doc
    // itself wasn't deleted — the UPDATE was; rollback reverts the
    // title change).
    const docRow = await driver
      .system()
      .selectFrom("docs")
      .select("title")
      .where("id", "=", DocId(DOC_ID_A))
      .executeTakeFirstOrThrow();
    expect(docRow.title).toBe("seed");
    expect(await fetchDocUpdates(DocId(DOC_ID_A))).toHaveLength(0);
    expect(await fetchOutbox()).toHaveLength(0);
    // Error audit still lands — `withAuditTx` opens its own
    // short-lived tx after the write-path tx rolls back.
    const audit = await fetchAuditEvents();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe("error");
  });

  it("output shape violation after ctx.transact: entire tuple rolls back", async () => {
    const { dispatcher } = mountContentDispatcher(
      buildDocMutateCapability(
        // Handler returns a value zod will reject (missing `text`).
        // biome-ignore lint/suspicious/noExplicitAny: handler invariant test.
        (async (): Promise<any> => ({ doc_id: "abc" })) as never,
      ),
    );
    await seedExistingDoc(DocId(DOC_ID_A));

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_MUTATE_ID,
        input: { doc_id: DOC_ID_A, text: "hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toThrow();

    const docRow = await driver
      .system()
      .selectFrom("docs")
      .select("title")
      .where("id", "=", DocId(DOC_ID_A))
      .executeTakeFirstOrThrow();
    expect(docRow.title).toBe("seed");
    expect(await fetchDocUpdates(DocId(DOC_ID_A))).toHaveLength(0);
    expect(await fetchOutbox()).toHaveLength(0);
    const audit = await fetchAuditEvents();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe("error");
  });

  it("post-parse deny after ctx.transact: entire tuple rolls back; deny audit persists", async () => {
    const { dispatcher } = mountContentDispatcher(
      buildDocMutateCapability(async () => {
        // Handler-owned deny decision (F88) — dispatcher recognises
        // the rethrow and rolls back the write-path tx. Deny audit
        // lands in a separate short-lived tx.
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { doc_id: DocId(DOC_ID_A) } },
        });
      }),
    );
    await seedExistingDoc(DocId(DOC_ID_A));

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_MUTATE_ID,
        input: { doc_id: DOC_ID_A, text: "hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const docRow = await driver
      .system()
      .selectFrom("docs")
      .select("title")
      .where("id", "=", DocId(DOC_ID_A))
      .executeTakeFirstOrThrow();
    expect(docRow.title).toBe("seed");
    expect(await fetchDocUpdates(DocId(DOC_ID_A))).toHaveLength(0);
    expect(await fetchOutbox()).toHaveLength(0);
    const audit = await fetchAuditEvents();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe("deny");
    expect(audit[0]?.deny_reason).toBe("acl_deny");
  });
});
