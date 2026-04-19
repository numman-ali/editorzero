/**
 * `DocUpdatesReader` over the shared Kysely surface (architecture.md §6.4 /
 * ADR 0018 F31). Dialect-agnostic — same factory runs against
 * `createSqliteDriver` and `createPostgresDriver`; empirically verified by
 * `packages/db/test/integration/writers.integration.test.ts`.
 *
 * Reads `doc_updates.update_blob` for a doc in seq order. Consumed by
 * the Hocuspocus `onLoadDocument` hook — each blob is applied to the
 * freshly-instantiated Y.Doc via `Y.applyUpdate`, rehydrating the
 * CRDT to the committed state before a handler's `ctx.transact` runs.
 *
 * **Reads through the write-path tx handle.** The reader accepts the
 * same `AuditTx` brand the audit + doc-updates writers accept, and
 * casts it back to `Transaction<SystemDatabase>` internally. Under
 * SQLite + better-sqlite3's single-connection model, a concurrent
 * read against `driver.system()` while `withSystemTx` holds the
 * connection would block on `acquireConnection` until the tx commits —
 * and `onLoadDocument` fires *inside* that tx. Routing the read
 * through the tx's own Kysely handle shares the connection, avoiding
 * the deadlock. Postgres's pool model tolerates a second connection,
 * but the shared-handle contract keeps the call site dialect-agnostic.
 *
 * **Read-your-own-writes is not a concern here.** Hydration runs in
 * `onLoadDocument`, which fires during `openDirectConnection` at the
 * start of `ctx.transact`. No `doc_updates` row for this doc has
 * been inserted in the tx yet — the writer runs after the handler
 * completes its CRDT mutation (§6.4). The read therefore returns the
 * same rows it would from a separate read-only connection:
 * committed state.
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
import type { Transaction } from "kysely";

import type { SystemDatabase } from "./schema";

export interface DocUpdatesReader {
  readByDoc(tx: AuditTx, doc_id: DocId): Promise<Uint8Array[]>;
}

export function createDocUpdatesReader(): DocUpdatesReader {
  return {
    readByDoc: async (auditTx, doc_id) => {
      const tx = auditTx as unknown as Transaction<SystemDatabase>;
      const rows = await tx
        .selectFrom("doc_updates")
        .select("update_blob")
        .where("doc_id", "=", doc_id)
        .orderBy("seq", "asc")
        .execute();
      return rows.map((r) => r.update_blob);
    },
  };
}
