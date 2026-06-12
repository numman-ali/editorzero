/**
 * `createDocUpdatesReader` unit tests.
 *
 * Locks the reader contract that `@editorzero/sync` depends on: one
 * `{seq, update_blob}` row per `doc_updates` row for the requested
 * `doc_id`, ordered by `seq` ascending, optionally restricted to
 * `seq > afterSeq` (the ADR 0043 watermark tail read). Reads run
 * through the `AuditTx` handle so they share the write-path tx's
 * connection under better-sqlite3's single-connection model (see
 * reader docstring). Reads scope to the doc — a second doc's updates
 * in the same DB are not returned.
 */

import { DocId, UserId, uuidV7, WorkspaceId } from "@editorzero/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAuditTx } from "./audit-writer";
import {
  createDocUpdatesReader,
  type DocUpdateRow,
  type DocUpdatesReader,
} from "./doc-updates-reader";
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
        access_mode: "space",
        published_slug: null,
        published_at: null,
        render_version: 0,
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
        access_mode: "space",
        published_slug: null,
        published_at: null,
        render_version: 0,
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

async function readByDoc(doc_id: DocId, afterSeq?: number): Promise<DocUpdateRow[]> {
  return driver.withSystemTx(async (tx) => reader.readByDoc(asAuditTx(tx), doc_id, afterSeq));
}

async function readByDocUntransacted(doc_id: DocId, afterSeq?: number): Promise<DocUpdateRow[]> {
  return reader.readByDocUntransacted(driver.system(), doc_id, afterSeq);
}

function flat(rows: DocUpdateRow[]): Array<[number, number[]]> {
  return rows.map((r) => [r.seq, Array.from(r.update_blob)]);
}

describe("createDocUpdatesReader.readByDoc", () => {
  it("returns an empty array when the doc has no updates", async () => {
    const rows = await readByDoc(DOC_A);
    expect(rows).toEqual([]);
  });

  it("returns one {seq, update_blob} row per update, in seq order, for the requested doc", async () => {
    await seedUpdate(DOC_A, 1, new Uint8Array([1]));
    await seedUpdate(DOC_A, 2, new Uint8Array([2]));
    await seedUpdate(DOC_A, 3, new Uint8Array([3]));
    expect(flat(await readByDoc(DOC_A))).toEqual([
      [1, [1]],
      [2, [2]],
      [3, [3]],
    ]);
  });

  it("orders by seq ascending even when rows were inserted out of seq order", async () => {
    // The writer always allocates seq sequentially, but the reader's
    // contract is "seq order" — a replay that walked rows in physical
    // insert order could desynchronise the CRDT if a later migration
    // or backfill inserted an older-seq row after a newer one.
    await seedUpdate(DOC_A, 3, new Uint8Array([3]));
    await seedUpdate(DOC_A, 1, new Uint8Array([1]));
    await seedUpdate(DOC_A, 2, new Uint8Array([2]));
    expect(flat(await readByDoc(DOC_A)).map(([seq]) => seq)).toEqual([1, 2, 3]);
  });

  it("does not return updates for a different doc", async () => {
    await seedUpdate(DOC_A, 1, new Uint8Array([10]));
    await seedUpdate(DOC_B, 1, new Uint8Array([20]));
    expect(flat(await readByDoc(DOC_A))).toEqual([[1, [10]]]);
    expect(flat(await readByDoc(DOC_B))).toEqual([[1, [20]]]);
  });

  it("afterSeq returns only the tail strictly past the watermark", async () => {
    // The ADR 0043 catch-up contract: `afterSeq` is the resident's
    // appliedSeq watermark; the tail must EXCLUDE the watermark row
    // itself (strict >) or every catch-up would double-apply the last
    // update. Double-apply is a Yjs no-op, but the contract stays
    // strict so the row count is meaningful to callers.
    await seedUpdate(DOC_A, 1, new Uint8Array([1]));
    await seedUpdate(DOC_A, 2, new Uint8Array([2]));
    await seedUpdate(DOC_A, 3, new Uint8Array([3]));
    expect(flat(await readByDoc(DOC_A, 2))).toEqual([[3, [3]]]);
    expect(await readByDoc(DOC_A, 3)).toEqual([]);
  });
});

describe("createDocUpdatesReader.readByDocUntransacted", () => {
  it("returns the same rows as readByDoc when run on committed state", async () => {
    // Pin the read-path hydration contract: outside any write-path tx,
    // the untransacted handle returns committed `doc_updates` in seq
    // order — identical to what `readByDoc` returns inside a tx. A
    // regression that made the two methods diverge would silently
    // desynchronise read-path hydration from write-path hydration.
    await seedUpdate(DOC_A, 1, new Uint8Array([1]));
    await seedUpdate(DOC_A, 2, new Uint8Array([2]));
    await seedUpdate(DOC_A, 3, new Uint8Array([3]));
    const viaTx = await readByDoc(DOC_A);
    const viaBase = await readByDocUntransacted(DOC_A);
    expect(flat(viaBase)).toEqual(flat(viaTx));
  });

  it("orders by seq ascending on the untransacted path", async () => {
    await seedUpdate(DOC_A, 3, new Uint8Array([3]));
    await seedUpdate(DOC_A, 1, new Uint8Array([1]));
    await seedUpdate(DOC_A, 2, new Uint8Array([2]));
    expect(flat(await readByDocUntransacted(DOC_A)).map(([seq]) => seq)).toEqual([1, 2, 3]);
  });

  it("scopes to the requested doc on the untransacted path", async () => {
    await seedUpdate(DOC_A, 1, new Uint8Array([10]));
    await seedUpdate(DOC_B, 1, new Uint8Array([20]));
    expect(flat(await readByDocUntransacted(DOC_A))).toEqual([[1, [10]]]);
    expect(flat(await readByDocUntransacted(DOC_B))).toEqual([[1, [20]]]);
  });

  it("afterSeq returns only the tail on the untransacted path", async () => {
    await seedUpdate(DOC_A, 1, new Uint8Array([1]));
    await seedUpdate(DOC_A, 2, new Uint8Array([2]));
    expect(flat(await readByDocUntransacted(DOC_A, 1))).toEqual([[2, [2]]]);
  });
});
