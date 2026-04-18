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
    // Y.Doc#transact is synchronous; it batches every mutation issued
    // inside the callback into a single update payload. If `fn` is async,
    // only the sync prefix up to the first `await` is batched — exactly
    // matches the Hocuspocus-backed impl's behaviour (Yjs transactions
    // are sync by design). We capture the raw return (T | Promise<T>)
    // inside the batch and `await` it outside so errors propagate
    // through the returned promise the same way for sync and async fns.
    let inner: T | Promise<T> | undefined;
    let thrown: unknown;
    let didThrow = false;
    ydoc.transact(() => {
      try {
        inner = fn(ydoc);
      } catch (e) {
        thrown = e;
        didThrow = true;
      }
    });
    if (didThrow) throw thrown;
    return await (inner as T | Promise<T>);
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
