/**
 * `DocUpdatesReader` over the shared Kysely surface (architecture.md §6.4 /
 * ADR 0018 F31). Dialect-agnostic — same factory runs against
 * `createSqliteDriver` and `createPostgresDriver`; empirically verified by
 * `packages/db/test/integration/writers.integration.test.ts`.
 *
 * Reads `doc_updates.update_blob` for a doc in seq order. Two call
 * shapes — both return the same rows in the same order, but pick the
 * one that matches the caller's transactional posture:
 *
 *   1. `readByDoc(tx: AuditTx, doc_id)` — **write-path hydration.**
 *      Called by the Hocuspocus `onLoadDocument` hook during
 *      `ctx.transact`, when the dispatcher is inside a write-path SQL
 *      tx. Reads through the tx's own Kysely handle so the read
 *      shares better-sqlite3's single connection with the enclosing
 *      `withSystemTx` — a concurrent `driver.system()` read would
 *      block on `acquireConnection` until commit, and `onLoadDocument`
 *      fires *inside* that tx. Postgres's pool tolerates a second
 *      connection, but sharing the handle keeps the call site
 *      dialect-agnostic.
 *   2. `readByDocUntransacted(db: Kysely<SystemDatabase>, doc_id)` —
 *      **read-path hydration.** Called by the Hocuspocus
 *      `onLoadDocument` hook under `HocuspocusSync.read(doc_id, fn)` —
 *      the dispatcher's read lane intentionally opens no SQL tx
 *      (§6.4: reads must not take the RESERVED lock `BEGIN IMMEDIATE`
 *      grabs). The untransacted handle is `driver.system()`; under
 *      WAL mode on SQLite it runs concurrently with live writers,
 *      and on Postgres it draws from the pool without contention.
 *
 * **Read-your-own-writes is not a concern** on either shape. Hydration
 * runs in `onLoadDocument`, which fires during `openDirectConnection`
 * at the start of `ctx.transact` / `sync.read`. On the write path,
 * no `doc_updates` row for this doc has been INSERTed in the tx yet —
 * the writer runs *after* the handler's CRDT mutation completes. On
 * the read path, there is no writer at all. Both shapes therefore
 * return committed state only.
 *
 * **Why a reader and not `sync` reaching into Kysely directly.** The
 * `no-raw-kysely-outside-db` coherence check (§8.1a + §17) pins every
 * raw Kysely import to `packages/db/**`. `@editorzero/sync` holds
 * Hocuspocus + Yjs and composes the hook body; this reader is the
 * sanctioned hand-off for the two `doc_updates` columns the hook
 * needs (`update_blob` in `seq` order).
 *
 * **Why not return the full rows.** The hook only applies
 * `update_blob`; returning the whole `DocUpdatesTable` tuple would
 * leak `principal_id`, `session_id`, `token_id` to the Y.Doc loader
 * that has no use for them and couldn't narrow their brands without
 * extra machinery. Returning `Uint8Array[]` keeps the reader's
 * contract tight to its one caller.
 */

import type { AuditTx } from "@editorzero/audit";
import type { DocId } from "@editorzero/ids";
import type { Kysely, Transaction } from "kysely";

import type { SystemDatabase, SystemDb } from "./schema";

export interface DocUpdatesReader {
  readByDoc(tx: AuditTx, doc_id: DocId): Promise<Uint8Array[]>;
  readByDocUntransacted(db: SystemDb, doc_id: DocId): Promise<Uint8Array[]>;
}

export function createDocUpdatesReader(): DocUpdatesReader {
  const readRows = async (handle: Kysely<SystemDatabase>, doc_id: DocId): Promise<Uint8Array[]> => {
    const rows = await handle
      .selectFrom("doc_updates")
      .select("update_blob")
      .where("doc_id", "=", doc_id)
      .orderBy("seq", "asc")
      .execute();
    return rows.map((r) => r.update_blob);
  };
  return {
    readByDoc: async (auditTx, doc_id) =>
      readRows(auditTx as unknown as Transaction<SystemDatabase>, doc_id),
    readByDocUntransacted: async (db, doc_id) => readRows(db, doc_id),
  };
}
