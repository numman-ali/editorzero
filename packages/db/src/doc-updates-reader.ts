/**
 * `DocUpdatesReader` over the shared Kysely surface (architecture.md §6.4 /
 * ADR 0018 F31). Dialect-agnostic — same factory runs against
 * `createSqliteDriver` and `createPostgresDriver`; empirically verified by
 * `packages/db/test/integration/writers.integration.test.ts`.
 *
 * Reads `doc_updates` rows for a doc in seq order. Two call shapes —
 * both return the same rows in the same order, but pick the one that
 * matches the caller's transactional posture:
 *
 *   1. `readByDoc(tx: AuditTx, doc_id, afterSeq?)` — **write-path
 *      reads.** Called during `ctx.transact`, when the dispatcher is
 *      inside a write-path SQL tx: first-load hydration of the
 *      resident Y.Doc, and the clone's tail top-up (ADR 0043 — the
 *      tx view deliberately includes this binding's own staged rows,
 *      which is exactly the read-your-own-writes the clone needs).
 *      Reads through the tx's own Kysely handle so the read shares
 *      better-sqlite3's single connection with the enclosing
 *      `withSystemTx` — a concurrent `driver.system()` read would
 *      block on `acquireConnection` until commit. Postgres's pool
 *      tolerates a second connection, but sharing the handle keeps
 *      the call site dialect-agnostic.
 *   2. `readByDocUntransacted(db: Kysely<SystemDatabase>, doc_id,
 *      afterSeq?)` — **read-path / WS-attach hydration.** Called
 *      under `HocuspocusSync.read` and on WebSocket attach — lanes
 *      that intentionally open no SQL tx (§6.4: reads must not take
 *      the RESERVED lock `BEGIN IMMEDIATE` grabs). The untransacted
 *      handle is `driver.system()`; under WAL mode on SQLite it runs
 *      concurrently with live writers, and on Postgres it draws from
 *      the pool without contention.
 *
 * **Rows carry `seq`** (ADR 0043): the sync layer tracks a per-resident
 * `appliedSeq` watermark so catch-up reads (`afterSeq`) fetch only the
 * tail, and hydration records how far the resident is caught up. The
 * other `doc_updates` columns (`principal_id`, `session_id`,
 * `token_id`) stay out of the contract — the Y.Doc loader has no use
 * for them and couldn't narrow their brands without extra machinery.
 *
 * **Why a reader and not `sync` reaching into Kysely directly.** The
 * `no-raw-kysely-outside-db` coherence check (§8.1a + §17) pins every
 * raw Kysely import to `packages/db/**`. `@editorzero/sync` holds
 * Hocuspocus + Yjs and composes the hook body; this reader is the
 * sanctioned hand-off for the columns the sync layer needs.
 */

import type { AuditTx } from "@editorzero/audit";
import type { DocId } from "@editorzero/ids";
import type { Kysely, Transaction } from "kysely";

import type { SystemDatabase, SystemDb } from "./schema";

export interface DocUpdateRow {
  readonly seq: number;
  readonly update_blob: Uint8Array;
}

export interface DocUpdatesReader {
  readByDoc(tx: AuditTx, doc_id: DocId, afterSeq?: number): Promise<DocUpdateRow[]>;
  readByDocUntransacted(db: SystemDb, doc_id: DocId, afterSeq?: number): Promise<DocUpdateRow[]>;
}

export function createDocUpdatesReader(): DocUpdatesReader {
  const readRows = async (
    handle: Kysely<SystemDatabase>,
    doc_id: DocId,
    afterSeq: number,
  ): Promise<DocUpdateRow[]> => {
    const rows = await handle
      .selectFrom("doc_updates")
      .select(["seq", "update_blob"])
      .where("doc_id", "=", doc_id)
      .where("seq", ">", afterSeq)
      .orderBy("seq", "asc")
      .execute();
    return rows.map((r) => ({ seq: r.seq, update_blob: r.update_blob }));
  };
  return {
    readByDoc: async (auditTx, doc_id, afterSeq = 0) =>
      readRows(auditTx as unknown as Transaction<SystemDatabase>, doc_id, afterSeq),
    readByDocUntransacted: async (db, doc_id, afterSeq = 0) => readRows(db, doc_id, afterSeq),
  };
}
