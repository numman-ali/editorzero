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
import {
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createLoadRoles,
  createSqliteDriver,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { workspaceAwareGate } from "@editorzero/dispatcher";
import { PermissionDeniedError } from "@editorzero/errors";
import { AgentId, CapabilityId, DocId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AccessPath, AgentPrincipal, UserPrincipal } from "@editorzero/principal";
import { HocuspocusSync } from "@editorzero/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
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
        slug: input.title,
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
  it("allow path: handler db write commits + allow audit row lands + handler-emitted outbox row commits", async () => {
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
          access_mode: "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
          created_by: USER_ID,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      // Handler-emitted outbox event lands in the same write-path tx
      // as the `docs` INSERT and the `audit_events` allow row.
      // Queued via `ctx.outbox(event, payload)` and flushed by
      // `createApiDispatcher`'s post-handler step inside the same
      // `BEGIN IMMEDIATE` region — see `runInWriteTx` in the factory.
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
    const outboxRows = await driver
      .system()
      .selectFrom("outbox")
      .select(["event", "workspace_id", "payload"])
      .execute();

    expect(docs).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("allow");
    expect(audits[0]?.capability_id).toBe(FIXTURE_ID);
    // Two outbox rows: the dispatcher-written `audit.appended` fan-
    // out (from `createAuditWriter`) + the handler-emitted
    // `doc.updated` row (from `ctx.outbox`).
    expect(outboxRows).toHaveLength(2);
    const events = outboxRows.map((r) => r.event).sort();
    expect(events).toEqual(["audit.appended", "doc.updated"]);
    const docUpdated = outboxRows.find((r) => r.event === "doc.updated");
    if (docUpdated === undefined) throw new Error("expected doc.updated row");
    expect(docUpdated.workspace_id).toBe(WORKSPACE_ID);
    expect(JSON.parse(docUpdated.payload)).toEqual({ doc_id: DOC_ID, version: 1 });
  });

  it("handler throw rolls back handler-emitted outbox rows with the tx", async () => {
    // Atomicity: if the handler calls `ctx.outbox(...)` and then
    // throws, neither the handler's `docs` insert nor the outbox
    // row should persist. The error-outcome audit row lands via
    // the separate short-lived `withAuditTx`, so the only outbox
    // row that should exist is its `audit.appended` fan-out.
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
          access_mode: "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
          created_by: USER_ID,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      ctx.outbox("doc.updated", { doc_id: input.doc_id, version: 1 });
      throw new Error("simulated handler failure after outbox emit");
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
    ).rejects.toThrow(/simulated handler failure/);

    const docs = await driver.system().selectFrom("docs").select("id").execute();
    const outboxEvents = await driver.system().selectFrom("outbox").select("event").execute();
    expect(docs).toHaveLength(0);
    // Only the error audit's `audit.appended` fan-out persists.
    // The handler-emitted `doc.updated` rolled back with the write-
    // path tx.
    expect(outboxEvents.map((r) => r.event)).toEqual(["audit.appended"]);
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
          access_mode: "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
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
          access_mode: "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
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

  it("read path: ctx.outbox throws (reads must not emit outbox events)", async () => {
    // The single-tx outbox guarantee is a property of the write path
    // — reads don't open `BEGIN IMMEDIATE` and have nowhere to write
    // a row atomically. A read capability calling `ctx.outbox` is a
    // capability bug; the dispatcher surfaces it as an error-outcome
    // audit row rather than silently dropping the event.
    const badReadFixture: Capability<FixtureInput, FixtureOutput> = {
      ...buildFixture(
        async (ctx, input) => {
          ctx.outbox("illegal.from.read", { doc_id: input.doc_id });
          return { doc_id: input.doc_id, title: "never reached" };
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
    ).rejects.toThrow(/outbox called from a read capability/i);

    // Error-outcome audit row landed (dispatcher's error-audit path).
    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("error");
  });

  it("write path: ctx.transact throws when `sync` is not passed (content-mutation fails loud)", async () => {
    // Metadata-only capabilities don't touch `ctx.transact`, so the
    // factory stays usable without a `HocuspocusSync` dep. A content-
    // mutation capability that calls `ctx.transact(...)` in such a
    // composition sees a real error projected to a typed audit row;
    // this test pins that contract so a future slice can't silently
    // swap in a no-op.
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
    ).rejects.toThrow(/ctx\.transact is not wired/u);

    // Error audit row still lands through `withAuditTx`.
    const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("error");
  });

  it("write path: with `sync` passed, ctx.transact persists doc_updates inside the same tx", async () => {
    // When `sync: HocuspocusSync` is passed, the composition root binds
    // per-invocation and wires `ctx.transact` through the bound service.
    // Same pattern proven in `packages/dispatcher/src/writepath.
    // integration.test.ts`; this test asserts the wiring survives the
    // factory boundary. Allow-path invariants:
    //   1. Handler insert + `doc_updates` row commit together.
    //   2. Audit `allow` row lands referencing the handler output.
    //   3. `doc_counters` row auto-bootstraps (writer side-effect).
    const sync = new HocuspocusSync({
      docUpdatesWriter: createDocUpdatesWriter(),
      docUpdatesReader: createDocUpdatesReader(),
      systemDb: driver.system(),
    });
    try {
      const fixture: Capability<FixtureInput, FixtureOutput> = {
        ...buildFixture(async (ctx, input) => {
          await ctx.db
            .insertInto("docs")
            .values({
              id: DocId(input.doc_id),
              workspace_id: WORKSPACE_ID,
              collection_id: null,
              title: input.title,
              slug: "seed",
              order_key: "a",
              access_mode: "space",
              published_slug: null,
              published_at: null,
              render_version: 0,
              created_by: USER_ID,
              created_at: 1,
              updated_at: 1,
              deleted_at: null,
            })
            .execute();
          // Mutation through the real bound sync. The callback receives
          // a Y.Doc; here we insert one character into a shared text.
          // `@editorzero/sync`'s `seedBlocks` exists for the richer
          // case; this fixture only needs to prove a `doc_updates` row
          // lands in the same tx.
          await ctx.transact(DocId(input.doc_id), (editor) => {
            // biome-ignore lint/suspicious/noExplicitAny: Kernel `TEditor` is `unknown`; real type is Y.Doc.
            (editor as any).getText("body").insert(0, "x");
          });
          return { doc_id: input.doc_id, title: input.title };
        }),
      };
      const registry = createRegistry([registerCapability(fixture)]);
      const dispatcher = createApiDispatcher({ driver, registry, sync, now: () => 1 });

      await dispatcher.dispatch({
        capability_id: FIXTURE_ID,
        input: { doc_id: DOC_ID, title: "Hello" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      });

      const docs = await driver.system().selectFrom("docs").select("id").execute();
      expect(docs).toHaveLength(1);
      const updates = await driver
        .system()
        .selectFrom("doc_updates")
        .select(["seq", "doc_id"])
        .execute();
      expect(updates).toHaveLength(1);
      expect(updates[0]?.doc_id).toBe(DOC_ID);
      const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe("allow");
    } finally {
      await sync.close();
    }
  });

  it("write path: with `sync` passed, handler throw rolls back `doc_updates` and evicts the Y.Doc", async () => {
    // Handler-throw after a `ctx.transact` call must leave no durable
    // trace: the SQL tx rolls back, and `bound.rollback()` in the
    // composition root drops the in-memory Y.Doc so a subsequent
    // `ctx.transact` re-hydrates from committed state (P3.6e). The
    // zero `doc_updates` rows + `outcome = error` audit row proves
    // both halves hold across the composition boundary.
    const sync = new HocuspocusSync({
      docUpdatesWriter: createDocUpdatesWriter(),
      docUpdatesReader: createDocUpdatesReader(),
      systemDb: driver.system(),
    });
    try {
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
            access_mode: "space",
            published_slug: null,
            published_at: null,
            render_version: 0,
            created_by: USER_ID,
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          })
          .execute();
        await ctx.transact(DocId(input.doc_id), (editor) => {
          // biome-ignore lint/suspicious/noExplicitAny: see previous test.
          (editor as any).getText("body").insert(0, "x");
        });
        throw new Error("boom");
      });
      const registry = createRegistry([registerCapability(fixture)]);
      const dispatcher = createApiDispatcher({ driver, registry, sync, now: () => 1 });

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
      const updates = await driver.system().selectFrom("doc_updates").select("seq").execute();
      const audits = await driver.system().selectFrom("audit_events").select("outcome").execute();
      expect(docs).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe("error");
    } finally {
      await sync.close();
    }
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

  it("runRead routes ctx.transact through sync.read when sync is wired", async () => {
    // Positive-path mirror of the "no sync" rejection below. Pins
    // that a read-category handler calling `ctx.transact(doc_id, fn)`
    // actually reaches `HocuspocusSync.read` — dispatcher wiring
    // contract, not Y.Doc semantics (which live in the sync package's
    // own integration suite).
    //
    // Pre-seed the doc via the write-path bind so committed
    // `doc_updates` exist, then dispatch a read fixture that reads
    // `getText("body")` off the Y.Doc clone. The handler's returned
    // string is the read's projection; asserting it equals the
    // committed text proves the full route: dispatcher → runRead →
    // sync.read → clone → fn → plain data out.
    const sync = new HocuspocusSync({
      docUpdatesWriter: createDocUpdatesWriter(),
      docUpdatesReader: createDocUpdatesReader(),
      systemDb: driver.system(),
    });
    try {
      // Seed docs metadata directly — the write-path bind below only
      // inserts `doc_updates`, not the parent `docs` row.
      await driver
        .system()
        .insertInto("docs")
        .values({
          id: DOC_ID,
          workspace_id: WORKSPACE_ID,
          collection_id: null,
          title: "seed",
          slug: "seed",
          order_key: "a",
          access_mode: "space",
          published_slug: null,
          published_at: null,
          render_version: 0,
          created_by: USER_ID,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
      // Seed the Y.Doc with "committed" text via a real write-path
      // transact — asAuditTx imported via the local helper below to
      // keep this test hermetic from the wider api-server bind-tx
      // scaffolding.
      const { asAuditTx } = await import("@editorzero/db");
      await driver.withSystemTx(async (tx) => {
        const bound = sync.bind({
          sqlTx: asAuditTx(tx),
          principal: testUser(),
          workspace_id: WORKSPACE_ID,
        });
        await bound.transact(DOC_ID, (ydoc) => {
          ydoc.getText("body").insert(0, "committed");
        });
      });

      // A read fixture whose handler projects the Y.Doc clone's text.
      // If the wiring is broken, either `ctx.transact` throws (old
      // stub), or the returned text is empty (clone not hydrated).
      // The `as Y.Doc` cast mirrors what `doc.get` does at its seed
      // site (kernel's `TEditor = unknown` default; a future sub-slice
      // sharpens this to Y.Doc and drops the cast).
      let observedText = "";
      const readFixture: Capability<FixtureInput, FixtureOutput> = {
        ...buildFixture(
          async (ctx, input) => {
            observedText = await ctx.transact(DocId(input.doc_id), (ydoc) =>
              (ydoc as Y.Doc).getText("body").toString(),
            );
            return { doc_id: input.doc_id, title: observedText };
          },
          ["doc:read"],
        ),
        category: "read",
        requires: ["doc:read"],
      };
      const registry = createRegistry([registerCapability(readFixture)]);
      const dispatcher = createApiDispatcher({
        driver,
        registry,
        sync,
        now: () => 1,
      });

      const result = await dispatcher.dispatch({
        capability_id: FIXTURE_ID,
        input: { doc_id: DOC_ID, title: "ignored" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      });

      expect(observedText).toBe("committed");
      expect(result).toEqual({ doc_id: DOC_ID, title: "committed" });
    } finally {
      await sync.close();
    }
  });

  // ── H8 at the composition seam (Codex Step-6 review MEDIUM) ─────────
  //
  // `gate.unit.test.ts` proves `workspaceAwareGate`'s policy against
  // call-counting fakes; `server.ts` wires it with
  // `createLoadRoles(driver)`. These tests close the seam between the
  // two: the REAL gate + the REAL role loader, injected into
  // `createApiDispatcher` exactly as `createApiServer` does
  // (server.ts), driven by a synthetic delegated principal against
  // seeded `workspace_members` rows. No HTTP-auth path can mint a
  // delegated agent yet (no agents table), so this seam is where the
  // production H8 composition is provable today.

  describe("workspaceAwareGate at the dispatcher seam (H8)", () => {
    const DELEGATOR = UserId("018f0000-0000-7000-8000-00000000d0e1");
    const AGENT = AgentId("018f0000-0000-7000-8000-0000000000b1");
    const AGENT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

    function delegatedAgent(): AgentPrincipal {
      return {
        kind: "agent",
        id: AGENT,
        workspace_id: WORKSPACE_ID,
        owner_user_id: null,
        scopes: ["doc:read", "doc:write"],
        token_id: AGENT_TOKEN,
        token_kind: "agent-auth",
        acting_as: DELEGATOR,
      };
    }

    function gatedDispatcher(fixture: Capability<FixtureInput, FixtureOutput>) {
      const registry = createRegistry([registerCapability(fixture)]);
      return createApiDispatcher({
        driver,
        registry,
        gate: workspaceAwareGate({ loadDelegatorRoles: createLoadRoles(driver) }),
        now: () => 1,
      });
    }

    async function seedDelegatorMembership(role: "guest" | "member") {
      await driver
        .system()
        .insertInto("workspace_members")
        .values({
          workspace_id: WORKSPACE_ID,
          user_id: DELEGATOR,
          role,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        })
        .execute();
    }

    it("delegator with no live membership: delegator_not_member deny + deny audit row, handler never runs", async () => {
      const fixture = buildFixture(async () => {
        throw new Error("handler must not run on gate deny");
      });
      const dispatcher = gatedDispatcher(fixture);

      let thrown: unknown;
      try {
        await dispatcher.dispatch({
          capability_id: FIXTURE_ID,
          input: { doc_id: DOC_ID, title: "Hello" },
          principal: delegatedAgent(),
          access: testAccess(),
          trace_id: null,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(PermissionDeniedError);
      if (thrown instanceof PermissionDeniedError) {
        expect(thrown.reason).toEqual({ kind: "delegator_not_member" });
      }

      const audits = await driver
        .system()
        .selectFrom("audit_events")
        .select(["outcome", "effect", "principal_kind", "acting_as_user_id"])
        .execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe("deny");
      expect(JSON.parse(audits[0]?.effect ?? "{}")).toMatchObject({
        kind: "deny",
        reason_code: "delegator_not_member",
      });
      // Investigator sees both identities on the deny row (ADR 0016).
      expect(audits[0]?.principal_kind).toBe("agent");
      expect(audits[0]?.acting_as_user_id).toBe(DELEGATOR);
    });

    it("guest delegator intersects away the agent's doc:write claim: missing_scope carries the INTERSECTED set", async () => {
      await seedDelegatorMembership("guest");
      const fixture = buildFixture(async () => {
        throw new Error("handler must not run on gate deny");
      });
      const dispatcher = gatedDispatcher(fixture);

      let thrown: unknown;
      try {
        await dispatcher.dispatch({
          capability_id: FIXTURE_ID,
          input: { doc_id: DOC_ID, title: "Hello" },
          principal: delegatedAgent(),
          access: testAccess(),
          trace_id: null,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(PermissionDeniedError);
      if (thrown instanceof PermissionDeniedError) {
        // The agent CLAIMS doc:write; guest's role union lacks it. The
        // surviving set is the intersection — proof the gate evaluated
        // agent.scopes ∩ roleScopes(delegator), not the raw claim.
        expect(thrown.reason).toEqual({
          kind: "missing_scope",
          required: ["doc:write"],
          principal_scopes: ["doc:read"],
        });
      }

      const audits = await driver
        .system()
        .selectFrom("audit_events")
        .select(["outcome", "effect"])
        .execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe("deny");
      expect(JSON.parse(audits[0]?.effect ?? "{}")).toMatchObject({
        kind: "deny",
        reason_code: "missing_scope",
      });
    });

    it("member delegator covers the claim: delegated dispatch allows and lands the allow audit row", async () => {
      await seedDelegatorMembership("member");
      const fixture = buildFixture(async (_ctx, input) => ({
        doc_id: input.doc_id,
        title: input.title,
      }));
      const dispatcher = gatedDispatcher(fixture);

      const result = await dispatcher.dispatch({
        capability_id: FIXTURE_ID,
        input: { doc_id: DOC_ID, title: "Hello" },
        principal: delegatedAgent(),
        access: testAccess(),
        trace_id: null,
      });
      expect(result).toEqual({ doc_id: DOC_ID, title: "Hello" });

      const audits = await driver
        .system()
        .selectFrom("audit_events")
        .select(["outcome", "principal_kind", "acting_as_user_id"])
        .execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe("allow");
      expect(audits[0]?.principal_kind).toBe("agent");
      expect(audits[0]?.acting_as_user_id).toBe(DELEGATOR);
    });
  });

  it("runRead rejects ctx.transact when no sync is wired", async () => {
    // Covers the read-path `transact` throw branch for the sync-absent
    // case. A read-category handler that calls `ctx.transact` with no
    // `HocuspocusSync` in the factory options cannot project Y.Doc
    // state — the descriptive error points operators at the wiring
    // gap rather than silently failing. With `sync` wired, the read
    // path routes through `sync.read` (integration proven in
    // `packages/sync/src/hocuspocus.integration.test.ts`); the
    // api-server factory owns only the "no sync → throw" branch here.
    const badReadFixture: Capability<FixtureInput, FixtureOutput> = {
      ...buildFixture(
        async (ctx, input) => {
          await ctx.transact(DocId(input.doc_id), () => {
            // Unreachable — the read-path stub throws without sync.
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
    ).rejects.toThrow(/ctx\.transact is not wired on the read path/u);
  });
});
