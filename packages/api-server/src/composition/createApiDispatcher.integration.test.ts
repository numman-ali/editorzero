/**
 * Integration test for the dispatcher composition root.
 *
 * Exercises `createApiDispatcher(...)` against a real in-memory SQLite
 * driver + a real audit writer + a fixture capability. The dispatcher
 * shape (parse → gate → invoke → parse → audit with write-path tx
 * atomicity) is already exhaustively covered by
 * `packages/dispatcher/src/writepath.integration.test.ts`; this file
 * only asserts what THIS factory owns: that the defaults plug in
 * correctly and that allow / gate-deny / handler-throw each reach the
 * right audit row and DB state.
 *
 * Intentionally narrow scope — duplicating every dispatcher scenario
 * here would be coverage theatre. The three-scenario shape (allow,
 * deny, error) matches what a composition-root smoke needs: one per
 * `AuditOutcome` branch, confirming the factory wires each leg to the
 * correct tx boundary.
 */

import {
  type Capability,
  type CapabilityContext,
  createRegistry,
  registerCapability,
} from "@editorzero/capabilities";
import { createSqliteDriver, SQLITE_FULL_DDL, type SqliteDriver } from "@editorzero/db";
import { PermissionDeniedError } from "@editorzero/errors";
import { CapabilityId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AccessPath, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiDispatcher } from "./createApiDispatcher";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_ID = DocId("018f0000-0000-7000-8000-0000000000a1");
const FIXTURE_ID = CapabilityId("doc.fixture");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
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

interface FixtureInput {
  readonly doc_id: string;
  readonly title: string;
}
interface FixtureOutput {
  readonly doc_id: string;
  readonly title: string;
}

function buildFixture(
  handler: (ctx: CapabilityContext, input: FixtureInput) => Promise<FixtureOutput>,
  requires: readonly ["doc:write" | "doc:read"] = ["doc:write"],
): Capability<FixtureInput, FixtureOutput> {
  return {
    id: FIXTURE_ID,
    category: "mutation",
    summary: "integration fixture",
    input: z.object({ doc_id: z.string(), title: z.string() }),
    output: z.object({ doc_id: z.string(), title: z.string() }),
    requires: [...requires],
    audit: {
      subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
      effectOnAllow: (input) => ({
        kind: "doc.rename",
        doc_id: DocId(input.doc_id),
        title: input.title,
      }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: FIXTURE_ID,
        required_scopes: ["doc:write"],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: FIXTURE_ID,
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler,
  };
}

describe("createApiDispatcher", () => {
  it("allow path: handler db write commits + allow audit row lands", async () => {
    const fixture = buildFixture(async (ctx, input) => {
      await ctx.db
        .insertInto("docs")
        .values({
          id: DocId(input.doc_id),
          workspace_id: WORKSPACE_ID,
          collection_id: null,
          title: input.title,
          slug: "seed",
          order_key: "a",
          visibility: "workspace",
          visibility_version: 0,
          created_by: USER_ID,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      // `ctx.outbox` is stubbed to a no-op until the sync-service
      // integration slice lands; calling it should not throw and
      // should not affect the dispatch outcome. Exercising the stub
      // here pins the current behaviour so a future slice that
      // replaces it with `INSERT INTO outbox` can't silently swallow
      // calls from existing handlers.
      ctx.outbox("doc.updated", { doc_id: input.doc_id, version: 1 });
      return { doc_id: input.doc_id, title: input.title };
    });
    const registry = createRegistry([registerCapability(fixture)]);
    const dispatcher = createApiDispatcher({ driver, registry, now: () => 1 });

    await dispatcher.dispatch({
      capability_id: FIXTURE_ID,
      input: { doc_id: DOC_ID, title: "Hello" },
      principal: testUser(),
      access: testAccess(),
      trace_id: null,
    });

    const docs = await driver.system().selectFrom("docs").select("id").execute();
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["outcome", "capability_id"])
      .execute();

    expect(docs).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("allow");
    expect(audits[0]?.capability_id).toBe(FIXTURE_ID);
  });

  it("gate deny: no db write, deny audit row lands via withAuditTx", async () => {
    // Require a scope the test user doesn't hold (`doc:delete`).
    const fixture = {
      ...buildFixture(async () => {
        throw new Error("handler must not run on gate deny");
      }),
      requires: ["doc:delete"] as const,
    };
    const registry = createRegistry([registerCapability(fixture)]);
    const dispatcher = createApiDispatcher({ driver, registry, now: () => 1 });

    await expect(
      dispatcher.dispatch({
        capability_id: FIXTURE_ID,
        input: { doc_id: DOC_ID, title: "Hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const docs = await driver.system().selectFrom("docs").select("id").execute();
    const audits = await driver
      .system()
      .selectFrom("audit_events")
      .select(["outcome", "deny_reason"])
      .execute();

    expect(docs).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("deny");
  });

  it("handler throw: write-path tx rolls back, error audit row still lands", async () => {
    const fixture = buildFixture(async (ctx, input) => {
      await ctx.db
        .insertInto("docs")
        .values({
          id: DocId(input.doc_id),
          workspace_id: WORKSPACE_ID,
          collection_id: null,
          title: input.title,
          slug: "seed",
          order_key: "a",
          visibility: "workspace",
          visibility_version: 0,
          created_by: USER_ID,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      throw new Error("boom");
    });
    const registry = createRegistry([registerCapability(fixture)]);
    const dispatcher = createApiDispatcher({ driver, registry, now: () => 1 });

    await expect(
      dispatcher.dispatch({
        capability_id: FIXTURE_ID,
        input: { doc_id: DOC_ID, title: "Hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toThrow();

    const docs = await driver.system().selectFrom("docs").select("id").execute();
    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();

    // Handler insert rolled back — zero docs rows.
    expect(docs).toHaveLength(0);
    // But the error audit row still persists through the separate
    // short-lived `withAuditTx`.
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("error");
  });

  it("read path: runRead extras supply a tenant-scoped db handle; no write-path tx opens", async () => {
    // Covers the `runRead` branch of the composition root — read-category
    // capabilities must run against `driver.scoped(workspace_id)` without
    // taking the RESERVED lock `runInWriteTx` holds. We seed a doc row
    // via a direct write so the handler has something to read, then
    // dispatch a read-category capability and assert:
    //   1. The handler received a working `ctx.db` that reads back the
    //      seeded row.
    //   2. An allow audit row landed (via `withAuditTx`).
    await driver.withSystemTx(async (tx) => {
      await tx
        .insertInto("docs")
        .values({
          id: DocId(DOC_ID),
          workspace_id: WORKSPACE_ID,
          collection_id: null,
          title: "seed",
          slug: "seed",
          order_key: "a",
          visibility: "workspace",
          visibility_version: 0,
          created_by: USER_ID,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
    });

    const readFixture: Capability<FixtureInput, FixtureOutput> = {
      ...buildFixture(
        async (ctx, input) => {
          const row = await ctx.db
            .selectFrom("docs")
            .select(["id", "title"])
            .where("id", "=", DocId(input.doc_id))
            .executeTakeFirst();
          if (row === undefined) throw new Error("seeded doc not found");
          // Exercise the read-path `outbox` stub (no-op today). Reads
          // don't normally emit outbox events, but the stub exists on
          // extras so reads calling it by mistake don't blow up —
          // dispatcher-level validation that reads don't emit events is
          // a separate concern.
          ctx.outbox("doc.updated", { doc_id: input.doc_id, version: 1 });
          return { doc_id: row.id, title: row.title };
        },
        ["doc:read"],
      ),
      category: "read",
      requires: ["doc:read"],
    };
    const registry = createRegistry([registerCapability(readFixture)]);
    const dispatcher = createApiDispatcher({ driver, registry, now: () => 1 });

    const result = await dispatcher.dispatch({
      capability_id: FIXTURE_ID,
      input: { doc_id: DOC_ID, title: "ignored" },
      principal: testUser(),
      access: testAccess(),
      trace_id: null,
    });

    expect(result).toEqual({ doc_id: DOC_ID, title: "seed" });
    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("allow");
  });

  it("write path: ctx.transact is stubbed to throw (content-mutation slice deferred)", async () => {
    // The composition root deliberately throws from `ctx.transact` until
    // the Hocuspocus `BoundSyncService` wiring slice lands. A content-
    // mutation capability that calls `ctx.transact(...)` sees a real
    // error it can surface; this test pins that contract so a future
    // slice can't silently swap in a no-op.
    const mutationFixture = buildFixture(async (ctx, input) => {
      await ctx.transact(DocId(input.doc_id), () => {
        // Unreachable — the stub throws before this runs.
      });
      return { doc_id: input.doc_id, title: input.title };
    });
    const registry = createRegistry([registerCapability(mutationFixture)]);
    const dispatcher = createApiDispatcher({ driver, registry, now: () => 1 });

    await expect(
      dispatcher.dispatch({
        capability_id: FIXTURE_ID,
        input: { doc_id: DOC_ID, title: "Hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toThrow(/ctx\.transact is not wired yet/u);

    // Error audit row still lands through `withAuditTx`.
    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("error");
  });

  it("default now: () => Date.now() is used when `now` is not overridden", async () => {
    // Covers the destructuring-default `now = () => Date.now()`.
    // Most tests override `now: () => 1` for determinism; this one
    // omits the override so the default closure is exercised. Audit
    // row assertions use a plausible-range check instead of exact
    // match because we've surrendered determinism on purpose.
    const before = Date.now();
    const fixture = buildFixture(
      async (_ctx, input) => {
        return { doc_id: input.doc_id, title: input.title };
      },
      ["doc:read"],
    );
    const readOnly: Capability<FixtureInput, FixtureOutput> = {
      ...fixture,
      category: "read",
      requires: ["doc:read"],
    };
    const registry = createRegistry([registerCapability(readOnly)]);
    const dispatcher = createApiDispatcher({ driver, registry }); // no `now`

    await dispatcher.dispatch({
      capability_id: FIXTURE_ID,
      input: { doc_id: DOC_ID, title: "Hello" },
      principal: testUser(),
      access: testAccess(),
      trace_id: null,
    });
    const after = Date.now();

    const audits = await driver.system().selectFrom("audit_events").select("created_at").execute();
    expect(audits).toHaveLength(1);
    const at = audits[0]?.created_at as number;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it("runRead rejects ctx.transact calls (reads must not mutate content)", async () => {
    // Covers the read-path `transact: async () => { throw ... }` branch.
    // A read-category handler that calls `ctx.transact` is a contract
    // violation — content mutation must route through the write path.
    const badReadFixture: Capability<FixtureInput, FixtureOutput> = {
      ...buildFixture(
        async (ctx, input) => {
          await ctx.transact(DocId(input.doc_id), () => {
            // Unreachable — the read-path stub throws.
          });
          return { doc_id: input.doc_id, title: input.title };
        },
        ["doc:read"],
      ),
      category: "read",
      requires: ["doc:read"],
    };
    const registry = createRegistry([registerCapability(badReadFixture)]);
    const dispatcher = createApiDispatcher({ driver, registry, now: () => 1 });

    await expect(
      dispatcher.dispatch({
        capability_id: FIXTURE_ID,
        input: { doc_id: DOC_ID, title: "ignored" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toThrow(/reads must not call ctx\.transact/u);
  });
});
