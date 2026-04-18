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
  createSqliteDriver,
  createTenantScopedDb,
  FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { PermissionDeniedError } from "@editorzero/errors";
import { CapabilityId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AccessPath, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(FULL_DDL);
});

afterEach(async () => {
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
