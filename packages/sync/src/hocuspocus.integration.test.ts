/**
 * `HocuspocusSync` — integration tests against real in-memory SQLite +
 * a real `Hocuspocus` instance (no WebSocket). Proves the write-path-tx
 * participation contract on the ADR 0043 broadcast-after-commit
 * substrate:
 *
 *   1. `bind(ctx).transact(doc, fn)` runs `fn` against a throwaway
 *      CLONE (resident snapshot + tx-view tail), never the resident.
 *   2. The Y.Doc update from `fn` lands in `doc_updates` under the
 *      caller's `AuditTx` — commits with it, rolls back with it — and
 *      is STAGED on the binding.
 *   3. `outbox(doc.updated)` is emitted in the same tx.
 *   4. Seq advances gaplessly across successive transacts.
 *   5. First-write bootstrap — the writer auto-creates `doc_counters`
 *      when it's missing, so `doc.create`'s `ctx.transact`-before-
 *      `docs`-INSERT path (as of 2026-04-18) works against the real
 *      backend without a separate priming step.
 *   6. Same-doc concurrent `transact` calls serialize through a per-doc
 *      mutex (clone construction + persist + commit-apply are atomic
 *      per doc).
 *   7. `commit()` is the broadcast moment: staged updates apply to the
 *      resident Y.Doc only AFTER the SQL tx commits; `rollback()`
 *      discards staged updates and the resident is never touched — the
 *      pre-0043 eviction/poisoning machinery is gone.
 *
 * These tests do not exercise the dispatcher — that integration lives
 * in `packages/dispatcher/src/writepath.integration.test.ts`. Here we
 * wire `HocuspocusSync` against a `driver.withSystemTx(asAuditTx(tx))`
 * directly (via the dispatcher-shaped `runTx` helper below), so the
 * sync contract is proven in isolation. The WS-visible half of the
 * substrate (no broadcast on rollback; broadcast arrives after
 * `commit()`) is pinned with real sockets in
 * `ws-attach.integration.test.ts`.
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
import type { BoundSyncService } from "./service";

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

function bindCtx(tx: Parameters<typeof asAuditTx>[0]): HocuspocusTxContext {
  return {
    sqlTx: asAuditTx(tx),
    principal: testPrincipal(),
    workspace_id: WORKSPACE_ID,
  };
}

/**
 * Dispatcher-shaped write invocation — mirrors `runInWriteTx` in
 * `createApiDispatcher`: open a SQL tx, `bind()`, run `fn` with the
 * binding, then `commit()` AFTER the tx committed (the broadcast
 * moment) or `rollback()` when it threw. Tests that pin the staged-
 * but-uncommitted window (resident lag, out-of-order commits) inline
 * these steps instead of using the helper.
 */
async function runTx<T>(fn: (bound: BoundSyncService) => Promise<T>): Promise<T> {
  let bound: BoundSyncService | undefined;
  try {
    const result = await driver.withSystemTx(async (tx) => {
      bound = sync.bind(bindCtx(tx));
      return fn(bound);
    });
    await bound?.commit();
    return result;
  } catch (err) {
    await bound?.rollback();
    throw err;
  }
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
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
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

async function readBody(doc_id: DocId): Promise<string> {
  return sync.read(doc_id, (ydoc) => ydoc.getText("body").toString());
}

describe("HocuspocusSync.bind().transact", () => {
  it("persists a doc_updates row + outbox(doc.updated) under the caller tx", async () => {
    await seedDocMetadata(DOC_ID_A);

    await runTx(async (bound) => {
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
      runTx(async (bound) => {
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
      runTx(async (bound) => {
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
      await runTx(async (bound) => {
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
    // Each runTx applied its staged update post-commit, so the
    // resident accumulated all three inserts.
    expect(await readBody(DOC_ID_A)).toBe("abc");
  });

  it("does not advance seq when a transact rolls back", async () => {
    await seedDocMetadata(DOC_ID_A);

    // First commit succeeds (seq=1).
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "a");
      });
    });

    // Second tx throws; seq should not have advanced.
    await expect(
      runTx(async (bound) => {
        await bound.transact(DOC_ID_A, (ydoc) => {
          ydoc.getText("body").insert(1, "b");
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    // Third commit succeeds; seq should be 2 (rolled-back tx left no
    // gap). §6.4 gapless property.
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(ydoc.getText("body").length, "c");
      });
    });

    const rows = await fetchDocUpdates(DOC_ID_A);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    // The rolled-back "b" never reaches the resident — staged updates
    // from an aborted tx are discarded, not applied.
    expect(await readBody(DOC_ID_A)).toBe("ac");
  });

  it("auto-bootstraps doc_counters on the first transact against a freshly-inserted docs row", async () => {
    // Closes Codex P3.6c adversarial P3 (bootstrap ordering). Only the
    // `docs` row is pre-seeded; the writer mints `doc_counters(next_seq=1)`
    // inside the same write-path tx as `doc_updates` + `outbox`.
    await seedDocMetadata(DOC_ID_A);

    await runTx(async (bound) => {
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
      runTx(async (bound) => {
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

    await runTx(async (bound) => {
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
    // the whole tuple (and stages nothing for `commit()` to apply).
    const counter = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID_A)
      .executeTakeFirst();
    expect(counter).toBeUndefined();
  });

  it("commit() on a binding that never staged anything is a no-op", async () => {
    // The dispatcher calls `commit()` unconditionally after every
    // committed write tx — including metadata-only dispatches whose
    // handler never touched `ctx.transact`. Must resolve cleanly and
    // leave no trace.
    await seedDocMetadata(DOC_ID_A);
    await runTx(async () => {
      /* no transact at all */
    });
    expect(await fetchDocUpdates(DOC_ID_A)).toHaveLength(0);
    expect(await readBody(DOC_ID_A)).toBe("");
  });

  it("captures Y.Doc updates issued after an `await` inside the handler", async () => {
    // Per `SyncService.transact`'s contract, `fn` may be async; the
    // docstring promises "anything after an `await` is its own update."
    // A naïve impl that detaches the 'update' listener in the sync-
    // callback's finally would drop those post-await mutations. This
    // test pins the correct behaviour — listener must span the full
    // `fn` Promise chain.
    await seedDocMetadata(DOC_ID_A);

    await runTx(async (bound) => {
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

  it("a later transact's clone sees prior committed state", async () => {
    await seedDocMetadata(DOC_ID_A);

    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        seedBlocks(ydoc, [
          { id: "018f0000-0000-7000-8000-0000000000a3", type: "paragraph", content: "first" },
        ]);
      });
    });

    const readBack = await runTx(async (bound) =>
      bound.transact(DOC_ID_A, (ydoc) => {
        const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
        return fragment.length;
      }),
    );

    // One top-level child on the fragment: the second invocation's
    // clone = resident snapshot (the first commit's `commit()` applied
    // seq 1) + tx-view tail (empty — watermark already at 1). Proves
    // continuity across invocations without a cold rehydration.
    expect(readBack).toBe(1);
  });

  it("read-your-own-writes: a second transact in the same binding sees the first's staged update", async () => {
    // ADR 0043's tail construction: the clone = resident snapshot
    // (committed ≤ watermark) + `doc_updates` rows with seq > watermark
    // read through the OPEN tx — which includes THIS binding's own
    // uncommitted rows. A handler that calls `ctx.transact` twice in
    // one dispatch must see its first write in the second call, even
    // though nothing has committed or applied to the resident yet.
    await seedDocMetadata(DOC_ID_A);

    let mid = "";
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "a");
      });
      await bound.transact(DOC_ID_A, (ydoc) => {
        const body = ydoc.getText("body");
        mid = body.toString();
        body.insert(body.length, "b");
      });
    });

    expect(mid).toBe("a");
    expect((await fetchDocUpdates(DOC_ID_A)).map((r) => r.seq)).toEqual([1, 2]);
    // Both staged rows applied to the resident at commit().
    expect(await readBody(DOC_ID_A)).toBe("ab");
  });

  it("resident stays committed-only until commit(): hot read lags, then catches up", async () => {
    // The D1 property at the sync seam, both halves deterministic:
    // after `withSystemTx` resolves (SQL durable) but BEFORE
    // `bound.commit()`, the resident — and therefore a hot read —
    // must not show the new delta (nothing was applied, so nothing
    // could have broadcast). `commit()` is the apply/broadcast
    // moment; the read flips immediately after.
    await seedDocMetadata(DOC_ID_A);

    let bound: BoundSyncService | undefined;
    await driver.withSystemTx(async (tx) => {
      bound = sync.bind(bindCtx(tx));
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "x");
      });
    });
    // SQL committed; the broadcast moment has not happened yet.
    expect(await fetchDocUpdates(DOC_ID_A)).toHaveLength(1);
    expect(await readBody(DOC_ID_A)).toBe("");

    if (bound === undefined) throw new Error("bind never ran");
    await bound.commit();
    expect(await readBody(DOC_ID_A)).toBe("x");
  });

  it("out-of-order commit() across two bindings converges (contiguous watermark)", async () => {
    // Two dispatches commit SQL in seq order but call `commit()` in
    // REVERSE order — the scheduling the dispatcher cannot rule out
    // across concurrent requests. Yjs application is commutative
    // (blob 2 parks as pending structs until blob 1 arrives), so the
    // resident converges to the same state either way. The watermark
    // advances contiguously: seq 2 parks in the ahead set until seq 1
    // applies, then both drain in one pass.
    await seedDocMetadata(DOC_ID_A);

    let boundA: BoundSyncService | undefined;
    await driver.withSystemTx(async (tx) => {
      boundA = sync.bind(bindCtx(tx));
      await boundA.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "1");
      });
    });
    let boundB: BoundSyncService | undefined;
    await driver.withSystemTx(async (tx) => {
      boundB = sync.bind(bindCtx(tx));
      await boundB.transact(DOC_ID_A, (ydoc) => {
        // B's clone sees A's committed row via the tail read even
        // though A has not applied to the resident yet.
        const body = ydoc.getText("body");
        body.insert(body.length, "2");
      });
    });
    if (boundA === undefined || boundB === undefined) throw new Error("bind never ran");

    await boundB.commit();
    await boundA.commit();

    expect(await readBody(DOC_ID_A)).toBe("12");
    // A third dispatch on top of the out-of-order pair: clone = fully
    // converged resident + empty tail (the ahead set drained when seq 1
    // landed, so the watermark sits at 2 and the tail re-fetches
    // neither blob).
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        const body = ydoc.getText("body");
        body.insert(body.length, "3");
      });
    });
    expect(await readBody(DOC_ID_A)).toBe("123");
    expect((await fetchDocUpdates(DOC_ID_A)).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("a transact INSIDE the out-of-order window still reads full committed state (contiguous watermark)", async () => {
    // The window a max-watermark gets wrong: seq 2 has applied to the
    // resident but committed seq 1 has not. A max would jump to 2 and
    // the next transact's tail (`seq > watermark`) would skip row 1 —
    // a clone silently missing durable state, handed to a handler as
    // truth (and carrying pending structs, which would false-refuse
    // the foreign-update lane's `not_integrable` check). The
    // contiguous watermark holds below the gap, so the tail re-serves
    // both rows and the clone is complete AND pending-free.
    await seedDocMetadata(DOC_ID_A);

    let boundA: BoundSyncService | undefined;
    await driver.withSystemTx(async (tx) => {
      boundA = sync.bind(bindCtx(tx));
      await boundA.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "1");
      });
    });
    let boundB: BoundSyncService | undefined;
    await driver.withSystemTx(async (tx) => {
      boundB = sync.bind(bindCtx(tx));
      await boundB.transact(DOC_ID_A, (ydoc) => {
        const body = ydoc.getText("body");
        body.insert(body.length, "2");
      });
    });
    if (boundA === undefined || boundB === undefined) throw new Error("bind never ran");

    // Open the window: B applied (parks ahead of the seq-1 gap), A not.
    await boundB.commit();

    let midWindowBody = "";
    let midWindowPending = true;
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        midWindowBody = ydoc.getText("body").toString();
        midWindowPending = ydoc.store.pendingStructs !== null;
        ydoc.getText("body").insert(ydoc.getText("body").length, "3");
      });
    });
    expect(midWindowBody).toBe("12");
    expect(midWindowPending).toBe(false);

    // The gap finally fills; the ahead set (seqs 2 and 3) drains in one
    // pass and the resident converges.
    await boundA.commit();
    expect(await readBody(DOC_ID_A)).toBe("123");

    // Post-window probe: the watermark drained to 3, so a fourth
    // transact's tail is empty and its clone is the converged resident.
    let postWindowBody = "";
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        const body = ydoc.getText("body");
        postWindowBody = body.toString();
        body.insert(body.length, "4");
      });
    });
    expect(postWindowBody).toBe("123");
    expect(await readBody(DOC_ID_A)).toBe("1234");
  });

  it("commit() after the doc unloaded is a quiet no-op — the next hydration covers it", async () => {
    // The not-resident arm of the post-commit apply: if the doc fell
    // out of memory between the SQL commit and `commit()` (instance
    // shutdown here; a debounce-driven unload in production), there
    // is nothing to apply or broadcast — the staged rows are durable,
    // and the next hydration replays them. `commit()` must resolve
    // (never-throws contract) and leave no stale watermark behind.
    await seedDocMetadata(DOC_ID_A);
    let bound: BoundSyncService | undefined;
    await driver.withSystemTx(async (tx) => {
      bound = sync.bind(bindCtx(tx));
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "x");
      });
    });
    if (bound === undefined) throw new Error("bind never ran");

    await sync.close();
    expect(sync._server_testOnly().documents.get(DOC_ID_A)).toBeUndefined();
    await expect(bound.commit()).resolves.toBeUndefined();

    sync = new HocuspocusSync({
      docUpdatesWriter: createDocUpdatesWriter(),
      docUpdatesReader: createDocUpdatesReader(),
      systemDb: driver.system(),
    });
    expect(await readBody(DOC_ID_A)).toBe("x");
  });

  it("a dropped commit() lags the resident but never corrupts the write lane", async () => {
    // Simulates the wiring bug the `BoundSyncService` docstring warns
    // about: a composition that forgets `bound.commit()`. The failure
    // is LIVENESS only — the resident (and live WS clients) lag — and
    // it heals at rehydration. The write lane stays correct: the next
    // transact's clone picks the orphaned row up via the tail read
    // (watermark still behind), and cold replay sees everything.
    await seedDocMetadata(DOC_ID_A);

    await driver.withSystemTx(async (tx) => {
      // commit() deliberately never called.
      await sync.bind(bindCtx(tx)).transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "first");
      });
    });

    let seen = "";
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        const body = ydoc.getText("body");
        seen = body.toString();
        body.insert(body.length, "!");
      });
    });
    expect(seen).toBe("first");
    expect((await fetchDocUpdates(DOC_ID_A)).map((r) => r.seq)).toEqual([1, 2]);

    // Heal path: a cold instance replays committed rows in full.
    await sync.close();
    sync = new HocuspocusSync({
      docUpdatesWriter: createDocUpdatesWriter(),
      docUpdatesReader: createDocUpdatesReader(),
      systemDb: driver.system(),
    });
    expect(await readBody(DOC_ID_A)).toBe("first!");
  });

  it("serialises concurrent same-doc transacts through the per-doc mutex", async () => {
    // Closes Codex P3.6c adversarial P1, reshaped by ADR 0043. Three
    // concurrent dispatches on the same doc each yield once mid-
    // transact. Clone-per-transact already prevents the original
    // cross-capture bug structurally (each invocation's `update`
    // listener lives on its own clone); the mutex remains load-
    // bearing for the open→snapshot→tail→persist sequence itself —
    // without it, two invocations could interleave their tail reads
    // and seq allocations, and `commit()` applies could race clone
    // construction.
    //
    // SQLite single-connection serialisation already funnels
    // `withSystemTx` calls, so this test over-verifies today; the
    // assertion is written to lock the behaviour for Postgres (ADR
    // 0007) where `withSystemTx` runs on independent connections and
    // the mutex becomes the load-bearing guarantee.
    await seedDocMetadata(DOC_ID_A);

    const run = (marker: string): Promise<void> =>
      runTx(async (bound) => {
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
    // The resident (all three commits applied) agrees with cold replay.
    expect(await readBody(DOC_ID_A)).toBe(replay.getText("body").toString());
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
    // the swap and the Y.Doc stays resident). Post-ADR-0043 the
    // singleton is also a correctness term: "any doc with uncommitted
    // `doc_updates` rows is resident" is what keeps cold WS/read
    // hydration committed-only on SQLite's single connection. Test
    // pins the invariant by driving 10 same-doc transacts and
    // asserting the server's `directConnectionsCount` stays at 1,
    // not 10.
    await seedDocMetadata(DOC_ID_A);
    const iterations = 10;
    for (let i = 0; i < iterations; i++) {
      await runTx(async (bound) => {
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

  it("rollback with a concurrent connection holder: resident untouched, no poison, no eviction needed", async () => {
    // The pre-ADR-0043 substrate mutated the resident during
    // `transact`, so a rollback had to EVICT the doc — and a holder
    // it could not kill (this direct-connection squatter) forced a
    // poisoned fail-closed state pinned by the predecessor of this
    // test. Under broadcast-after-commit the whole dilemma dissolves:
    // the aborted mutation only ever existed on the throwaway clone,
    // so there is nothing to evict, nothing to poison, and the
    // squatter is irrelevant. Same fixture, opposite (now correct)
    // outcome.
    await seedDocMetadata(DOC_ID_A);

    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "committed");
      });
    });

    const squatter = await sync._server_testOnly().openDirectConnection(DOC_ID_A, {});
    await expect(
      runTx(async (bound) => {
        await bound.transact(DOC_ID_A, (ydoc) => {
          ydoc.getText("body").insert(0, "rolled-back");
        });
        throw new Error("post-transact throw");
      }),
    ).rejects.toThrow("post-transact throw");

    // Durable state clean (SQL tx rolled back).
    expect((await fetchDocUpdates(DOC_ID_A)).map((r) => r.seq)).toEqual([1]);

    // With the squatter STILL attached: both open paths serve
    // committed state — no refusal, no rolled-back delta.
    expect(await readBody(DOC_ID_A)).toBe("committed");
    let observed = "";
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        observed = ydoc.getText("body").toString();
      });
    });
    expect(observed).toBe("committed");

    await squatter.disconnect();
  });

  it("isolates writes across doc_ids", async () => {
    await seedDocMetadata(DOC_ID_A);
    await seedDocMetadata(DOC_ID_B);

    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "A");
      });
    });
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_B, (ydoc) => {
        ydoc.getText("body").insert(0, "B");
      });
    });

    expect((await fetchDocUpdates(DOC_ID_A)).length).toBe(1);
    expect((await fetchDocUpdates(DOC_ID_B)).length).toBe(1);
    expect(await readBody(DOC_ID_A)).toBe("A");
    expect(await readBody(DOC_ID_B)).toBe("B");
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
      runTx(async (bound) => {
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
  //
  // Post-ADR-0043 the read is committed-only BY CONSTRUCTION: the
  // resident never holds pre-commit state, so neither does the
  // snapshot clone a read hands its handler.

  it("hydrates via untransacted reader on a cold doc and returns committed state", async () => {
    await seedDocMetadata(DOC_ID_A);

    // Write two committed updates through the write-path bind.
    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "hello");
      });
    });
    await runTx(async (bound) => {
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

    const observed = await readBody(DOC_ID_A);
    expect(observed).toBe("hello world");
  });

  it("returns an empty Y.Doc when no doc_updates rows exist", async () => {
    await seedDocMetadata(DOC_ID_A);

    const observed = await readBody(DOC_ID_A);
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

    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "hello");
      });
    });

    await sync.read(DOC_ID_A, (ydoc) => {
      // A misbehaving handler. Must NOT affect subsequent state.
      ydoc.getText("body").insert(0, "ghost-");
    });

    const observed = await readBody(DOC_ID_A);
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

    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "hello");
      });
    });

    await sync.read(DOC_ID_A, (ydoc) => {
      ydoc.getText("body").insert(0, "ghost-");
    });

    await runTx(async (bound) => {
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

    const coldRead = await readBody(DOC_ID_A);
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
    const emptyRead = await readBody(DOC_ID_A);
    expect(emptyRead).toBe("");

    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "a");
      });
    });

    // write → read: read after the dispatch (SQL commit + commit())
    // sees the written state.
    const afterWrite = await readBody(DOC_ID_A);
    expect(afterWrite).toBe("a");
  });

  it("sees state from an in-process transact once commit() has applied it", async () => {
    // Hot-doc path — read after a full dispatcher-shaped write,
    // without a restart. The Y.Doc stays resident (open-replace keeps
    // `directConnectionsCount` >= 1 across the transact→read swap), so
    // `onLoadDocument` does not re-fire; the read sees the state
    // `commit()` applied to the resident at the broadcast moment.
    await seedDocMetadata(DOC_ID_A);

    await runTx(async (bound) => {
      await bound.transact(DOC_ID_A, (ydoc) => {
        ydoc.getText("body").insert(0, "hot");
      });
    });

    const observed = await readBody(DOC_ID_A);
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
