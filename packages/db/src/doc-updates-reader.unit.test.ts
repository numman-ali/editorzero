/**
 * `createDocUpdatesReader` unit tests.
 *
 * Locks the reader contract that `@editorzero/sync`'s `onLoadDocument`
 * hook depends on: one `Uint8Array` per `doc_updates` row for the
 * requested `doc_id`, ordered by `seq` ascending. Reads run through
 * the `AuditTx` handle so they share the write-path tx's connection
 * under better-sqlite3's single-connection model (see reader
 * docstring). Reads scope to the doc — a second doc's updates in the
 * same DB are not returned.
 */

import { DocId, UserId, uuidV7, WorkspaceId } from "@editorzero/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAuditTx } from "./audit-writer";
import { createDocUpdatesReader, type DocUpdatesReader } from "./doc-updates-reader";
import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { FULL_DDL } from "./drivers/sqlite-ddl";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_A = DocId("018f0000-0000-7000-8000-0000000000a1");
const DOC_B = DocId("018f0000-0000-7000-8000-0000000000a2");

let driver: SqliteDriver;
let reader: DocUpdatesReader;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(FULL_DDL);
  reader = createDocUpdatesReader();
  const now = 1_700_000_000_000;
  await driver
    .system()
    .insertInto("docs")
    .values([
      {
        id: DOC_A,
        workspace_id: WORKSPACE_ID,
        collection_id: null,
        title: "a",
        slug: "a",
        order_key: "a",
        visibility: "workspace",
        visibility_version: 0,
        created_by: USER_ID,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
      {
        id: DOC_B,
        workspace_id: WORKSPACE_ID,
        collection_id: null,
        title: "b",
        slug: "b",
        order_key: "b",
        visibility: "workspace",
        visibility_version: 0,
        created_by: USER_ID,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
    ])
    .execute();
});

afterEach(async () => {
  await driver.close();
});

async function seedUpdate(doc_id: DocId, seq: number, blob: Uint8Array): Promise<void> {
  await driver
    .system()
    .insertInto("doc_updates")
    .values({
      id: uuidV7(),
      doc_id,
      workspace_id: WORKSPACE_ID,
      seq,
      update_blob: blob,
      principal_kind: "user",
      principal_id: USER_ID,
      session_id: null,
      created_at: 1_700_000_000_000 + seq,
      delete_after: null,
    })
    .execute();
}

async function readByDoc(doc_id: DocId): Promise<Uint8Array[]> {
  return driver.withSystemTx(async (tx) => reader.readByDoc(asAuditTx(tx), doc_id));
}

describe("createDocUpdatesReader.readByDoc", () => {
  it("returns an empty array when the doc has no updates", async () => {
    const blobs = await readByDoc(DOC_A);
    expect(blobs).toEqual([]);
  });

  it("returns one Uint8Array per row, in seq order, for the requested doc", async () => {
    await seedUpdate(DOC_A, 1, new Uint8Array([1]));
    await seedUpdate(DOC_A, 2, new Uint8Array([2]));
    await seedUpdate(DOC_A, 3, new Uint8Array([3]));
    const blobs = await readByDoc(DOC_A);
    expect(blobs.map((b) => Array.from(b))).toEqual([[1], [2], [3]]);
  });

  it("orders by seq ascending even when rows were inserted out of seq order", async () => {
    // The writer always allocates seq sequentially, but the reader's
    // contract is "seq order" — a replay that walked rows in physical
    // insert order could desynchronise the CRDT if a later migration
    // or backfill inserted an older-seq row after a newer one.
    await seedUpdate(DOC_A, 3, new Uint8Array([3]));
    await seedUpdate(DOC_A, 1, new Uint8Array([1]));
    await seedUpdate(DOC_A, 2, new Uint8Array([2]));
    const blobs = await readByDoc(DOC_A);
    expect(blobs.map((b) => Array.from(b))).toEqual([[1], [2], [3]]);
  });

  it("does not return updates for a different doc", async () => {
    await seedUpdate(DOC_A, 1, new Uint8Array([10]));
    await seedUpdate(DOC_B, 1, new Uint8Array([20]));
    const blobsA = await readByDoc(DOC_A);
    const blobsB = await readByDoc(DOC_B);
    expect(blobsA.map((b) => Array.from(b))).toEqual([[10]]);
    expect(blobsB.map((b) => Array.from(b))).toEqual([[20]]);
  });
});
