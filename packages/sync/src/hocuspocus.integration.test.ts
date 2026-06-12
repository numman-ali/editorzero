/**
 * `HocuspocusSync` — integration tests against real in-memory SQLite +
 * a real `Hocuspocus` instance (no WebSocket). Proves the write-path-tx
 * participation contract:
 *
 *   1. `bind(ctx).transact(doc, fn)` runs `fn` against a live Y.Doc.
 *   2. The Y.Doc update from `fn` lands in `doc_updates` under the
 *      caller's `AuditTx` — commits with it, rolls back with it.
 *   3. `outbox(doc.updated)` is emitted in the same tx.
 *   4. Seq advances gaplessly across successive transacts.
 *   5. First-write bootstrap — the writer auto-creates `doc_counters`
 *      when it's missing, so `doc.create`'s `ctx.transact`-before-
 *      `docs`-INSERT path (as of 2026-04-18) works against the real
 *      backend without a separate priming step.
 *   6. Same-doc concurrent `transact` calls serialize through a per-doc
 *      mutex so update listeners never cross-contaminate.
 *
 * These tests do not exercise the dispatcher — that integration lives
 * in `packages/dispatcher/src/writepath.integration.test.ts`. Here we
 * wire `HocuspocusSync` against a `driver.withSystemTx(asAuditTx(tx))`
 * directly, so the sync contract is proven in isolation.
 */

import {
  asAuditTx,
  createAuditWriter,
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createSqliteDriver,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { DocId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DOC_FRAGMENT, seedBlocks } from "./blocks";
import { HocuspocusSync, type HocuspocusTxContext } from "./hocuspocus";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_ID_A = DocId("018f0000-0000-7000-8000-0000000000a1");
const DOC_ID_B = DocId("018f0000-0000-7000-8000-0000000000a2");

let driver: SqliteDriver;
let sync: HocuspocusSync;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
  sync = new HocuspocusSync({
    docUpdatesWriter: createDocUpdatesWriter(),
    docUpdatesReader: createDocUpdatesReader(),
    systemDb: driver.system(),
  });
});

afterEach(async () => {
  await sync.close();
  await driver.close();
});

function testPrincipal(): UserPrincipal {
  return {
    kind: "user",
    id: USER_ID,
    workspace_id: WORKSPACE_ID,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

async function seedDocMetadata(doc_id: DocId): Promise<void> {
  const now = Date.now();
  // Only the `docs` row is pre-seeded — the `DocUpdatesWriter` auto-
  // bootstraps `doc_counters` on first write via ON CONFLICT DO NOTHING.
  // Pre-seeding the counter here would mask a regression that re-
  // introduced the pre-bootstrap assumption. Mirrors how real
  // `doc.create` will look after the re-order commit in this slice.
  //
  // `slug` / `order_key` are derived from `doc_id` so tests that seed
  // multiple docs in the same workspace don't collide on the partial
  // unique index `docs_root_slug_unique` (collections slice 1 DDL).
  await driver
    .system()
    .insertInto("docs")
    .values({
      id: doc_id,
      workspace_id: WORKSPACE_ID,
      collection_id: null,
      title: "test",
      slug: doc_id,
      order_key: doc_id,
      visibility: "workspace",
      visibility_version: 0,
      created_by: USER_ID,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
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

describe("HocuspocusSync.bind().transact", () => {
  it("persists a doc_updates row + outbox(doc.updated) under the caller tx", async () => {
    await seedDocMetadata(DOC_ID_A);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        seedBlocks(ydoc, [
          { id: "018f0000-0000-7000-8000-0000000000a1", type: "paragraph", content: "hello" },
        ]);
      });
    });

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(1);
    expect(rows[0]?.update_blob.length).toBeGreaterThan(0);

    const outbox = await fetchOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event).toBe("doc.updated");
    const payload = JSON.parse(outbox[0]?.payload ?? "{}") as { doc_id: string; seq: number };
    expect(payload.doc_id).toBe(DOC_ID_A);
    expect(payload.seq).toBe(1);
  });

  it("rolls back doc_updates + outbox when the outer tx rejects", async () => {
    await seedDocMetadata(DOC_ID_A);

    await expect(
      driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, (ydoc) => {
          seedBlocks(ydoc, [
            { id: "018f0000-0000-7000-8000-0000000000a2", type: "paragraph", content: "hello" },
          ]);
        });
        throw new Error("caller rolls back");
      }),
    ).rejects.toThrow("caller rolls back");

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows).toHaveLength(0);
    const outbox = await fetchOutbox();
    expect(outbox).toHaveLength(0);
  });

  it("propagates handler errors and leaves no doc_updates row", async () => {
    await seedDocMetadata(DOC_ID_A);

    await expect(
      driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, () => {
          throw new Error("handler boom");
        });
      }),
    ).rejects.toThrow("handler boom");

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows).toHaveLength(0);
    const outbox = await fetchOutbox();
    expect(outbox).toHaveLength(0);
  });

  it("advances seq gaplessly across successive transacts on the same doc", async () => {
    await seedDocMetadata(DOC_ID_A);

    for (const text of ["a", "b", "c"]) {
      await driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, (ydoc) => {
          ydoc.getText("body").insert(ydoc.getText("body").length, text);
        });
      });
    }

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    // The `doc_counters.next_seq` advances exactly as many times as
    // we committed; gapless on success is the property §6.4 requires.
    const counter = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID_A)
      .executeTakeFirstOrThrow();
    expect(counter.next_seq).toBe(4);
  });

  it("does not advance seq when a transact rolls back", async () => {
    await seedDocMetadata(DOC_ID_A);

    // First commit succeeds (seq=1).
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "a");
      });
    });

    // Second tx throws; seq should not have advanced.
    await expect(
      driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, (ydoc) => {
          ydoc.getText("body").insert(1, "b");
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    // Third commit succeeds; seq should be 2 (rolled-back tx left no
    // gap). §6.4 gapless property.
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(ydoc.getText("body").length, "c");
      });
    });

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("auto-bootstraps doc_counters on the first transact against a freshly-inserted docs row", async () => {
    // Closes Codex P3.6c adversarial P3 (bootstrap ordering). Only the
    // `docs` row is pre-seeded; the writer mints `doc_counters(next_seq=1)`
    // inside the same write-path tx as `doc_updates` + `outbox`.
    await seedDocMetadata(DOC_ID_A);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "first");
      });
    });

    const counter = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID_A)
      .executeTakeFirstOrThrow();
    expect(counter.next_seq).toBe(2);
    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(1);
  });

  it("surfaces an FK error when transact is called before the docs row is inserted", async () => {
    // No `docs` row at all. The writer's INSERT OR IGNORE on
    // `doc_counters` hits `doc_counters.doc_id REFERENCES docs(id)`
    // and fails before any partial write can land. Callers must
    // INSERT `docs` before the first `ctx.transact`.
    await expect(
      driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, (ydoc) => {
          ydoc.getText("body").insert(0, "oops");
        });
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    expect(await fetchDocUpdates(DOC_ID_A)).toHaveLength(0);
  });

  it("skips the doc_updates write when the handler issues no Y.Doc mutations", async () => {
    await seedDocMetadata(DOC_ID_A);

    // `createAuditWriter()` imported so this file's test-setup
    // mirrors the full write-path even though the assertion only
    // touches doc_updates here. Prevents a future "this file forgot
    // to import the audit writer" drift signal.
    void createAuditWriter;

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (_ydoc) => {
        // deliberately no mutation
      });
    });

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows).toHaveLength(0);
    const outbox = await fetchOutbox();
    expect(outbox).toHaveLength(0);
    // No-mutation transacts skip the writer entirely, so the counter
    // isn't even bootstrapped. Empty transact is a true no-op across
    // the whole tuple.
    const counter = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID_A)
      .executeTakeFirst();
    expect(counter).toBeUndefined();
  });

  it("captures Y.Doc updates issued after an `await` inside the handler", async () => {
    // Per `SyncService.transact`'s contract, `fn` may be async; the
    // docstring promises "anything after an `await` is its own update."
    // A naïve impl that detaches the 'update' listener in the sync-
    // callback's finally would drop those post-await mutations. This
    // test pins the correct behaviour — listener must span the full
    // `fn` Promise chain.
    await seedDocMetadata(DOC_ID_A);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, async (ydoc) => {
        ydoc.getText("body").insert(0, "sync");
        await Promise.resolve(); // yield — detaches any naive listener
        ydoc.getText("body").insert(ydoc.getText("body").length, "-async");
      });
    });

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows).toHaveLength(1);

    // Replay the merged update into a fresh Y.Doc and confirm both
    // the sync and post-await inserts survived the capture window.
    const replay = new Y.Doc();
    Y.applyUpdate(replay, rows[0]?.update_blob as Uint8Array);
    expect(replay.getText("body").toString()).toBe("sync-async");
  });

  it("keeps Y.Doc state resident across transacts so projections see the prior state", async () => {
    await seedDocMetadata(DOC_ID_A);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        seedBlocks(ydoc, [
          { id: "018f0000-0000-7000-8000-0000000000a3", type: "paragraph", content: "first" },
        ]);
      });
    });

    const readBack = await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      return bound.transact(DOC_ID_A, (ydoc) => {
        const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
        return fragment.length;
      });
    });

    // One top-level child on the fragment; proves the fragment survived
    // across invocations without a hydration step (`unloadImmediately:
    // false` keeps the doc resident).
    expect(readBack).toBe(1);
  });

  it("serialises concurrent same-doc transacts through the per-doc mutex", async () => {
    // Closes Codex P3.6c adversarial P1. Three concurrent dispatches
    // on the same doc each yield once mid-transact. Without a mutex,
    // one invocation's `update` listener (still attached across the
    // `await`) would capture another invocation's delta; with the
    // mutex, each `open → mutate → persist` sequence completes before
    // the next begins, so each `doc_updates` row carries exactly one
    // invocation's inserts.
    //
    // SQLite single-connection serialisation already funnels
    // `withSystemTx` calls, so this test over-verifies today; the
    // assertion is written to lock the behaviour for Postgres (ADR
    // 0007) where `withSystemTx` runs on independent connections and
    // the mutex becomes the load-bearing guarantee.
    await seedDocMetadata(DOC_ID_A);

    const run = (marker: string): Promise<void> =>
      driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, async (ydoc) => {
          const body = ydoc.getText("body");
          body.insert(body.length, `[${marker}`);
          await Promise.resolve();
          body.insert(body.length, `${marker}]`);
        });
      });

    await Promise.all([run("A"), run("B"), run("C")]);

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);

    const replay = new Y.Doc();
    for (const row of rows) Y.applyUpdate(replay, row.update_blob);
    // No interleaving — each `[X … X]` block stays contiguous.
    expect(replay.getText("body").toString()).toMatch(/^(\[(A|B|C)\2\]){3}$/);
  });

  it("per-doc retention is bounded across invocations (Codex P3.6e adversarial)", async () => {
    // Regression guard on the open-replace pattern inside
    // `#runTransactLocked`. Before P3.6e, each `ctx.transact` left its
    // `DirectConnection` alive and registered in a per-doc
    // `Set<DirectConnection>` until `HocuspocusSync.close()` — memory
    // grew O(invocations) per doc. The fix opens a replacement
    // connection per call, stores it in the singleton map, and
    // disconnects the predecessor in `finally` AFTER the new one is
    // registered (so `directConnectionsCount` never drops to 0 during
    // the swap and the Y.Doc stays resident). Test pins the invariant
    // by driving 10 same-doc transacts and asserting the server's
    // `directConnectionsCount` stays at 1, not 10.
    await seedDocMetadata(DOC_ID_A);
    const iterations = 10;
    for (let i = 0; i < iterations; i++) {
      await driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, (ydoc) => {
          ydoc.getText("body").insert(0, `${i}`);
        });
      });
    }

    const server = sync._server_testOnly();
    const document = server.documents.get(DOC_ID_A);
    if (document === undefined) throw new Error("expected document resident");
    // `directConnectionsCount` == 1 proves the predecessor was
    // disconnected on each swap, not accumulated. 10 invocations, 1
    // live connection.
    expect(document.directConnectionsCount).toBe(1);
    // All `iterations` `doc_updates` rows landed — functional path
    // unbroken by the open-replace refactor.
    expect(await fetchDocUpdates(DOC_ID_A)).toHaveLength(iterations);
  });

  it("rollback leaves the doc resident when a concurrent connection holds it (WS-client limit regression guard)", async () => {
    // P3.6e class docstring "In-memory rollback scope" claim:
    // `bound.rollback()` disconnects our per-doc singleton, but
    // Hocuspocus's `shouldUnloadDocument` gates unload on
    // `getConnectionsCount() === 0` — including WebSocket client
    // connections. In production with live browser editors attached,
    // rolling back a server-side `ctx.transact` cannot evict the
    // Document, so the rolled-back delta stays resident and a
    // subsequent `ctx.transact` reads the polluted state. This test
    // pins that as a *known* limit, not accidental: if someone "fixes"
    // this by force-closing WebSocket connections on rollback, this
    // test fails and forces them to justify the UX tradeoff (dropping
    // live editor sessions mid-edit). The real closure is Phase 4's
    // broadcast-suppression work.
    await seedDocMetadata(DOC_ID_A);

    // Simulate a WebSocket client by opening a second direct
    // connection from outside our bind. This holds the Document
    // resident independently of our bind's singleton.
    const squatter = await sync._server_testOnly().openDirectConnection(DOC_ID_A, {});
    try {
      await expect(
        driver.withSystemTx(async (tx) => {
          const ctx: HocuspocusTxContext = {
            sqlTx: asAuditTx(tx),
            principal: testPrincipal(),
            workspace_id: WORKSPACE_ID,
          };
          const bound = sync.bind(ctx);
          try {
            await bound.transact(DOC_ID_A, (ydoc) => {
              ydoc.getText("body").insert(0, "rolled-back");
            });
            throw new Error("post-transact throw");
          } catch (err) {
            await bound.rollback();
            throw err;
          }
        }),
      ).rejects.toThrow("post-transact throw");

      // Durable state clean (SQL tx rolled back).
      expect(await fetchDocUpdates(DOC_ID_A)).toHaveLength(0);

      // BUT the Y.Doc is still resident (squatter keeps the count
      // above 0). A subsequent ctx.transact sees the polluted state.
      let observed = "";
      await driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, (ydoc) => {
          observed = ydoc.getText("body").toString();
        });
      });
      expect(observed).toBe("rolled-back");
    } finally {
      await squatter.disconnect();
    }
  });

  it("isolates writes across doc_ids", async () => {
    await seedDocMetadata(DOC_ID_A);
    await seedDocMetadata(DOC_ID_B);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "A");
      });
    });
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_B, (ydoc) => {
        ydoc.getText("body").insert(0, "B");
      });
    });

    expect((await fetchDocUpdates(DOC_ID_A)).length).toBe(1);
    expect((await fetchDocUpdates(DOC_ID_B)).length).toBe(1);
  });
});

describe("HocuspocusSync.close", () => {
  it("is idempotent", async () => {
    await sync.close();
    await expect(sync.close()).resolves.toBeUndefined();
  });

  it("bound().close() is a no-op — the shared server is not per-invocation closable", async () => {
    // Close is the only SyncService method that doesn't need a tx,
    // so we build a context with a stub sqlTx that would throw if
    // touched. `bound.close()` never dereferences it.
    const stubCtx: HocuspocusTxContext = {
      sqlTx: null as unknown as ReturnType<typeof asAuditTx>,
      principal: testPrincipal(),
      workspace_id: WORKSPACE_ID,
    };
    const bound = sync.bind(stubCtx);
    await expect(bound.close()).resolves.toBeUndefined();
  });

  it("rejects transact after close", async () => {
    await seedDocMetadata(DOC_ID_A);
    await sync.close();
    await expect(
      driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        await bound.transact(DOC_ID_A, (ydoc) => {
          ydoc.getText("body").insert(0, "x");
        });
      }),
    ).rejects.toThrow(/after close/);
  });
});

describe("HocuspocusSync.read", () => {
  // Pins the tx-less read seam (§6.4 — "reads must not take the
  // RESERVED lock `BEGIN IMMEDIATE` grabs"). Proves:
  //
  //   1. Read on a cold doc (no resident Y.Doc, committed `doc_updates`
  //      rows on disk) hydrates via the untransacted reader and
  //      reflects the committed state.
  //   2. Read on an empty doc (row exists in `docs` but no
  //      `doc_updates` rows) yields a fresh Y.Doc with no content.
  //   3. Read does NOT persist a `doc_updates` row — even when the
  //      handler mutates the Y.Doc, the update is ephemeral.
  //   4. Read does NOT mint an `outbox` entry.
  //   5. Concurrent same-doc read + transact serialise through the
  //      per-doc mutex — the read never observes a half-mutated Y.Doc.
  //   6. Read after close rejects.

  it("hydrates via untransacted reader on a cold doc and returns committed state", async () => {
    await seedDocMetadata(DOC_ID_A);

    // Write two committed updates through the write-path bind.
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "hello");
      });
    });
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        const body = ydoc.getText("body");
        body.insert(body.length, " world");
      });
    });

    // Force the doc out of memory so `read` has to hydrate from disk.
    // Uses `sync.close()` + a fresh HocuspocusSync against the same
    // driver — simulates a cold server restart, which is the only
    // path where `onLoadDocument` actually has work to do under the
    // read seam. In-process `read` after the same `transact` would hit
    // the still-resident Y.Doc and skip the hook entirely.
    await sync.close();
    sync = new HocuspocusSync({
      docUpdatesWriter: createDocUpdatesWriter(),
      docUpdatesReader: createDocUpdatesReader(),
      systemDb: driver.system(),
    });

    const observed = await sync.read(DOC_ID_A, (ydoc) => ydoc.getText("body").toString());
    expect(observed).toBe("hello world");
  });

  it("returns an empty Y.Doc when no doc_updates rows exist", async () => {
    await seedDocMetadata(DOC_ID_A);

    const observed = await sync.read(DOC_ID_A, (ydoc) => ydoc.getText("body").toString());
    expect(observed).toBe("");
  });

  it("does not write a doc_updates row even when the handler mutates the Y.Doc", async () => {
    // Reads must stay ephemeral — a misuse like `sync.read(doc, y =>
    // y.getText("body").insert(0, "…"))` must not silently persist.
    // The write-path keeps `doc_updates` durable via the `update`
    // listener + writer; the read path registers neither, so in-
    // handler mutations evaporate.
    await seedDocMetadata(DOC_ID_A);

    await sync.read(DOC_ID_A, (ydoc) => {
      ydoc.getText("body").insert(0, "should not persist");
    });

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows).toHaveLength(0);
    const outbox = await fetchOutbox();
    expect(outbox).toHaveLength(0);
  });

  it("mutating inside read() does not pollute the resident Y.Doc observed by the next read", async () => {
    // Regression guard on the contamination bug Codex caught during the
    // Slice-1 review: prior to the clone-before-fn shape, `read(fn)`
    // handed `fn` the *live resident* Y.Doc. A mutating handler dirtied
    // the in-memory state without firing a `doc_updates` row (the read
    // path registers no `update` listener), and a subsequent `read` or
    // `transact` observed the polluted state. The fix snapshots the
    // live doc, materialises a throwaway clone, and hands that clone
    // to `fn` — the live doc is never exposed.
    //
    // This test asserts the narrow claim: a mutating read's state is
    // invisible to the next hot read. The cold-replay taint case
    // (write after mutating read re-merges against polluted state) is
    // the next test.
    await seedDocMetadata(DOC_ID_A);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "hello");
      });
    });

    await sync.read(DOC_ID_A, (ydoc) => {
      // A misbehaving handler. Must NOT affect subsequent state.
      ydoc.getText("body").insert(0, "ghost-");
    });

    const observed = await sync.read(DOC_ID_A, (ydoc) => ydoc.getText("body").toString());
    expect(observed).toBe("hello");
  });

  it("mutating inside read() does not taint durable state after a subsequent write", async () => {
    // Second half of the contamination guard. Same setup as the
    // hot-read test above, but after the mutating read we also issue a
    // real write-path transact that appends "!". Under the bug, the
    // write's `update` listener captured "!" relative to the polluted
    // live doc (`ghost-hello`), and the committed `doc_updates` row
    // carried delta-against-poisoned-state. Cold replay from committed
    // rows produced `hello!` in durable state — but the *hot* doc read
    // `ghost-hello!`. The two diverged. The clone-before-fn fix keeps
    // the live doc equal to committed state throughout, so the
    // write's captured delta is faithful and cold replay equals hot
    // state.
    await seedDocMetadata(DOC_ID_A);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "hello");
      });
    });

    await sync.read(DOC_ID_A, (ydoc) => {
      ydoc.getText("body").insert(0, "ghost-");
    });

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        const body = ydoc.getText("body");
        body.insert(body.length, "!");
      });
    });

    // Cold replay — close + re-open so hydration comes purely from
    // committed `doc_updates` rows, no resident Y.Doc.
    await sync.close();
    sync = new HocuspocusSync({
      docUpdatesWriter: createDocUpdatesWriter(),
      docUpdatesReader: createDocUpdatesReader(),
      systemDb: driver.system(),
    });

    const coldRead = await sync.read(DOC_ID_A, (ydoc) => ydoc.getText("body").toString());
    expect(coldRead).toBe("hello!");
  });

  it("serialises read-then-write + write-then-read on the same doc through the per-doc mutex", async () => {
    // Pins the mutex ordering across both shapes (`transact` + `read`).
    // **Under SQLite's single-connection model** we can't assert the
    // mutex by kicking a read concurrently against an in-flight
    // `withSystemTx`: the write holds the connection and would block
    // the read's untransacted SELECT, while the read holds the mutex
    // and blocks the write's `bound.transact` — a connection/mutex
    // ordering inversion that deadlocks. That pathological shape is
    // unreachable in the real dispatcher (read-path callers never wrap
    // `sync.read` inside a `withSystemTx`), so we assert the mutex
    // invariant via sequential runs instead: a read after a write sees
    // the post-write state, and a write after a read commits its
    // delta. The Postgres-backed integration (ADR 0007) where
    // `withSystemTx` runs on independent connections is where the
    // truly-concurrent shape would matter — left for that lane.
    await seedDocMetadata(DOC_ID_A);

    // read → write: read on empty doc yields "", write then persists.
    const emptyRead = await sync.read(DOC_ID_A, (ydoc) => ydoc.getText("body").toString());
    expect(emptyRead).toBe("");

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "a");
      });
    });

    // write → read: read after commit sees the written state.
    const afterWrite = await sync.read(DOC_ID_A, (ydoc) => ydoc.getText("body").toString());
    expect(afterWrite).toBe("a");
  });

  it("sees state from an in-process transact when it's already resident", async () => {
    // Hot-doc path — read after transact without a restart. The Y.Doc
    // stays resident (open-replace pattern keeps `directConnectionsCount`
    // >= 1 across the transact→read swap), so `onLoadDocument` does not
    // re-fire; the read sees the same Y.Doc the transact mutated.
    await seedDocMetadata(DOC_ID_A);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "hot");
      });
    });

    const observed = await sync.read(DOC_ID_A, (ydoc) => ydoc.getText("body").toString());
    expect(observed).toBe("hot");
  });

  it("rejects read after close", async () => {
    await seedDocMetadata(DOC_ID_A);
    await sync.close();
    await expect(sync.read(DOC_ID_A, (ydoc) => ydoc.getText("body").toString())).rejects.toThrow(
      /after close/,
    );
  });
});
