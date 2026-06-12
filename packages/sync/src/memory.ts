/**
 * `MemorySyncService` — in-process `SyncService` implementation.
 *
 * Holds one `Y.Doc` per `DocId` in a `Map`. There is no persistence and
 * no peer replication; this is the driver for unit tests and for the
 * single-process dev runtime that doesn't run a full Hocuspocus server.
 *
 * The Y.Doc's memory lives until `close()` or until the instance is
 * garbage-collected. No LRU, no TTL — for tests and small dev sessions
 * this is fine; production always uses the Hocuspocus-backed impl.
 */

import type { DocId } from "@editorzero/ids";
import * as Y from "yjs";

import type { SyncService } from "./service";

export class MemorySyncService implements SyncService {
  readonly #docs = new Map<DocId, Y.Doc>();
  #closed = false;

  async transact<T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new Error("MemorySyncService: transact called after close()");
    }
    const ydoc = this.#getOrCreate(doc_id);
    // `fn` runs directly against the doc — NO ambient `ydoc.transact`
    // wrapper, matching the Hocuspocus-backed impl post-ADR-0043 (the
    // clone is handed to `fn` bare; each mutation's update event fires
    // synchronously, which the capture brackets in both the write-path
    // binding and `applyForeignUpdate` rely on — an outer transaction
    // would defer every event past the listeners' detach). Owned-layer
    // writes still batch internally: `writeBlocks` / `seedBlocks` /
    // `setDocTitle` wrap their reconciliation in updateYFragment's own
    // transaction, so they emit one event per call either way.
    return await fn(ydoc);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const ydoc of this.#docs.values()) {
      ydoc.destroy();
    }
    this.#docs.clear();
  }

  #getOrCreate(doc_id: DocId): Y.Doc {
    const existing = this.#docs.get(doc_id);
    if (existing !== undefined) return existing;
    const ydoc = new Y.Doc();
    this.#docs.set(doc_id, ydoc);
    return ydoc;
  }
}
