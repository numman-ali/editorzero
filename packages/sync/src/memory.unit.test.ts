/**
 * `MemorySyncService` — per-method unit tests.
 *
 * Exercises the invariants the `SyncService` contract bakes in: one
 * Y.Doc per `DocId`, mutations issued inside `transact` persist into
 * that Y.Doc, sync + async fn return values + errors both flow through,
 * and `close()` releases the Y.Docs.
 */

import { DocId } from "@editorzero/ids";
import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";

import { MemorySyncService } from "./memory";

const DOC_A = DocId("01961111-0000-7000-8000-aaaaaaaaaaaa");
const DOC_B = DocId("01961111-0000-7000-8000-bbbbbbbbbbbb");

describe("MemorySyncService.transact", () => {
  let svc: MemorySyncService;

  afterEach(async () => {
    await svc?.close();
  });

  it("passes a Y.Doc to the callback and returns its result", async () => {
    svc = new MemorySyncService();
    const out = await svc.transact(DOC_A, (ydoc) => {
      ydoc.getText("body").insert(0, "hello");
      return "ok";
    });
    expect(out).toBe("ok");
  });

  it("persists mutations across invocations for the same doc_id", async () => {
    svc = new MemorySyncService();
    await svc.transact(DOC_A, (ydoc) => {
      ydoc.getText("body").insert(0, "hello");
    });
    const read = await svc.transact(DOC_A, (ydoc) => ydoc.getText("body").toString());
    expect(read).toBe("hello");
  });

  it("isolates Y.Docs by doc_id", async () => {
    svc = new MemorySyncService();
    await svc.transact(DOC_A, (ydoc) => {
      ydoc.getText("body").insert(0, "A");
    });
    await svc.transact(DOC_B, (ydoc) => {
      ydoc.getText("body").insert(0, "B");
    });
    const a = await svc.transact(DOC_A, (ydoc) => ydoc.getText("body").toString());
    const b = await svc.transact(DOC_B, (ydoc) => ydoc.getText("body").toString());
    expect(a).toBe("A");
    expect(b).toBe("B");
  });

  it("batches sync mutations into a single Yjs update", async () => {
    svc = new MemorySyncService();
    const updates: Uint8Array[] = [];
    // Subscribe via a priming transact so we can grab the Y.Doc handle.
    const ydoc = await svc.transact(DOC_A, (d) => d);
    ydoc.on("update", (update: Uint8Array) => {
      updates.push(update);
    });
    await svc.transact(DOC_A, (d) => {
      d.getText("body").insert(0, "a");
      d.getText("body").insert(1, "b");
      d.getText("body").insert(2, "c");
    });
    expect(updates).toHaveLength(1);
  });

  it("supports async callbacks and resolves to their awaited value", async () => {
    svc = new MemorySyncService();
    const out = await svc.transact(DOC_A, async (ydoc) => {
      ydoc.getText("body").insert(0, "x");
      await Promise.resolve();
      return 42;
    });
    expect(out).toBe(42);
  });

  it("propagates synchronous errors from the callback", async () => {
    svc = new MemorySyncService();
    await expect(
      svc.transact(DOC_A, () => {
        throw new Error("boom-sync");
      }),
    ).rejects.toThrow("boom-sync");
  });

  it("propagates async errors from the callback", async () => {
    svc = new MemorySyncService();
    await expect(
      svc.transact(DOC_A, async () => {
        await Promise.resolve();
        throw new Error("boom-async");
      }),
    ).rejects.toThrow("boom-async");
  });

  it("rejects transact after close()", async () => {
    svc = new MemorySyncService();
    await svc.close();
    await expect(svc.transact(DOC_A, (d) => d)).rejects.toThrow(/after close/);
  });
});

describe("MemorySyncService.close", () => {
  it("destroys the backing Y.Docs so readers see they're gone", async () => {
    const svc = new MemorySyncService();
    let captured: Y.Doc | undefined;
    await svc.transact(DOC_A, (d) => {
      captured = d;
    });
    let destroyed = false;
    captured?.on("destroy", () => {
      destroyed = true;
    });
    await svc.close();
    expect(destroyed).toBe(true);
  });

  it("is idempotent", async () => {
    const svc = new MemorySyncService();
    await svc.close();
    await expect(svc.close()).resolves.toBeUndefined();
  });
});
