// @vitest-environment happy-dom
/// <reference lib="dom" />

/**
 * BlockNoteEditor adapter-boundary smoke (Appendix C item 11; ADR 0018).
 *
 * Closes the no-WS half of item 11: constructs a headless
 * `BlockNoteEditor.create({ collaboration: { fragment } })` against a
 * live `Y.XmlFragment` from `openDirectConnection.transact()`, exercises
 * `editor.transact(insertBlocks)`, and verifies the mutation flows
 * through the y-prosemirror collab plugin into the Y.XmlFragment, gets
 * captured by `HocuspocusSync`'s update listener, and persists through
 * the write-path tx as a `doc_updates` row + `outbox(doc.updated)` row.
 *
 * The WS-client concurrent-edit half of item 11 depends on Phase 4
 * broadcast-buffering-until-commit (ADR 0018 § Out of scope) and is
 * not addressed here.
 *
 * The lower-level Y.Doc / Hocuspocus seam is already covered by
 * `hocuspocus.integration.test.ts`. This file exercises the *adapter*
 * boundary — proving the headless `BlockNoteEditor` is the primitive
 * surface adapters hand to capability handlers (vs. raw Y.Doc API),
 * and that mutations through it round-trip durably.
 */

import {
  BlockNoteEditor,
  type BlockSchema,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import {
  asAuditTx,
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
import {
  BLOCKNOTE_FRAGMENT,
  type LooseBlock,
  type LoosePartialBlock,
  readBlocks,
  seedBlocks,
} from "./blocks";
import { HocuspocusSync, type HocuspocusTxContext } from "./hocuspocus";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_ID = DocId("018f0000-0000-7000-8000-0000000000b1");

let driver: SqliteDriver;
let sync: HocuspocusSync;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
  sync = new HocuspocusSync({
    docUpdatesWriter: createDocUpdatesWriter(),
    docUpdatesReader: createDocUpdatesReader(),
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
  await driver
    .system()
    .insertInto("docs")
    .values({
      id: doc_id,
      workspace_id: WORKSPACE_ID,
      collection_id: null,
      title: "test",
      slug: "test",
      order_key: "a",
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

async function fetchOutboxEvents(): Promise<string[]> {
  const rows = await driver.system().selectFrom("outbox").select(["event"]).execute();
  return rows.map((r) => r.event);
}

/**
 * Reduce BlockNote blocks to `[type, text]` tuples — stable across
 * UUID regeneration but tight enough to catch structural drift
 * (extra/missing blocks, type changes, content mutation).
 *
 * **Why this is structurally load-bearing.** The live BlockNote editor
 * normalises the document by appending a trailing empty paragraph on
 * first mutation; `seedBlocks` (pure conversion path) does *not*. So
 * the difference between `[…, ["paragraph", ""]]` and a clean tail is
 * itself the proof that y-prosemirror's collab plugin fired — without
 * that trailing empty, a silent regression where `editor.transact`
 * was a no-op (e.g., DOM-shim drift, mount lifecycle break, plugin
 * detach) could still satisfy a substring-only assertion. Pinning the
 * tuple shape pins the signal.
 */
function summarize(blocks: readonly LooseBlock[]): Array<[string, string]> {
  return blocks.map((b) => {
    const parts = Array.isArray(b.content) ? (b.content as ReadonlyArray<{ text?: unknown }>) : [];
    const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    return [b.type, text];
  });
}

/**
 * Construct a headless `BlockNoteEditor` bound to the given live
 * `Y.XmlFragment` and mount it onto a detached DOM element.
 *
 * **Why the mount.** The collab plugin (y-prosemirror) writes back to
 * the fragment via ProseMirror's `appendTransaction` chain, but
 * transactions only get applied to the EditorState through `view.dispatch`.
 * Without an `EditorView`, `editor.insertBlocks` is a silent no-op:
 * the plugin's hook never fires and the fragment never sees the change.
 * Verified empirically — the first iteration of this smoke skipped
 * `mount()` and produced zero `doc_updates` rows. Same constraint the
 * `blocks.ts` docstring already flags ("server-side that means either
 * a `jsdom` + `editor.mount(...)` dance or `Hocuspocus.openDirectConnection`")
 * — it's not "or", it's "both": the DirectConnection gives us the live
 * fragment, the mount gives us a working dispatch path. **Production
 * surface adapters that mutate via `BlockNoteEditor` will need a DOM
 * shim (jsdom / happy-dom) in their runtime, not just at test time.**
 *
 * Caller MUST call `dispose()` when done. Unmount + destroy in that
 * order — `unmount` detaches the view, `destroy` releases ProseMirror
 * state + the y-prosemirror plugin's listeners.
 */
type LiveEditor = BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>;

function liveEditor(fragment: Y.XmlFragment): {
  readonly editor: LiveEditor;
  dispose(): void;
} {
  const editor = BlockNoteEditor.create({
    collaboration: {
      fragment,
      user: { name: "ez claude", color: "#000000" },
    },
  }) as unknown as LiveEditor;
  const host = document.createElement("div");
  editor.mount(host);
  return {
    editor,
    dispose: () => {
      editor.unmount();
      editor._tiptapEditor.destroy();
    },
  };
}

describe("BlockNoteEditor adapter-boundary smoke (Appendix C item 11)", () => {
  it("editor.transact(insertBlocks) writes to the live fragment + persists durably", async () => {
    await seedDocMetadata(DOC_ID);

    // First tx: seed the doc with a paragraph via the existing
    // ephemeral-editor path so we have a referenceBlock for insertBlocks.
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID, (ydoc) => {
        seedBlocks(ydoc, [{ type: "paragraph", content: "seeded" } as LoosePartialBlock]);
      });
    });

    // Second tx: the actual smoke — bind a live BlockNoteEditor to the
    // resident Y.XmlFragment, mutate via `editor.transact(insertBlocks)`,
    // and let HocuspocusSync's update listener capture the resulting
    // Yjs delta + persist it through the write-path tx.
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID, (ydoc) => {
        const fragment = ydoc.getXmlFragment(BLOCKNOTE_FRAGMENT);
        const { editor, dispose } = liveEditor(fragment);
        try {
          const referenceId = editor.document[0]?.id;
          if (referenceId === undefined) {
            throw new Error("expected seeded block to be visible to live editor");
          }
          editor.transact(() => {
            editor.insertBlocks(
              [{ type: "paragraph", content: "from editor" } as LoosePartialBlock],
              referenceId,
              "after",
            );
          });
        } finally {
          dispose();
        }
      });
    });

    // Two doc_updates rows committed: seed (seq=1), editor-mutate (seq=2).
    const rows = await fetchDocUpdates(DOC_ID);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);

    // Each tx emits one `doc.updated` outbox row.
    expect(await fetchOutboxEvents()).toEqual(["doc.updated", "doc.updated"]);

    // Final projection: the live editor's normalisation appended a
    // trailing empty paragraph on the editor-mutate tx — its presence
    // is the structural signal that y-prosemirror actually dispatched
    // (see `summarize` doc above). Pure `seedBlocks` does not produce
    // a trailing empty, so any silent regression where the editor-mutate
    // tx degraded to a no-op would visibly drop this row.
    const replay = new Y.Doc();
    for (const row of rows) Y.applyUpdate(replay, row.update_blob);
    expect(summarize(readBlocks(replay))).toEqual([
      ["paragraph", "seeded"],
      ["paragraph", "from editor"],
      ["paragraph", ""],
    ]);
  });

  it("durable state replays into a fresh Y.Doc and projects both blocks", async () => {
    await seedDocMetadata(DOC_ID);

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID, (ydoc) => {
        seedBlocks(ydoc, [{ type: "paragraph", content: "alpha" } as LoosePartialBlock]);
      });
    });

    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID, (ydoc) => {
        const fragment = ydoc.getXmlFragment(BLOCKNOTE_FRAGMENT);
        const { editor, dispose } = liveEditor(fragment);
        try {
          const referenceId = editor.document[0]?.id;
          if (referenceId === undefined) throw new Error("no seeded block visible");
          editor.transact(() => {
            editor.insertBlocks(
              [{ type: "paragraph", content: "beta" } as LoosePartialBlock],
              referenceId,
              "after",
            );
          });
        } finally {
          dispose();
        }
      });
    });

    // Replay the durable update stream onto a fresh Y.Doc + project.
    // This is the path a server restart / replica catch-up would take
    // — proves the editor's collab-plugin writes are real Yjs updates,
    // not in-memory editor state.
    const replay = new Y.Doc();
    for (const row of await fetchDocUpdates(DOC_ID)) {
      Y.applyUpdate(replay, row.update_blob);
    }
    expect(summarize(readBlocks(replay))).toEqual([
      ["paragraph", "alpha"],
      ["paragraph", "beta"],
      // Live editor normalisation tail — see `summarize` doc.
      ["paragraph", ""],
    ]);
  });

  it("editor mutations roll back with the outer SQL tx", async () => {
    await seedDocMetadata(DOC_ID);

    // Seed first (durable) so the resident Y.Doc has a referenceBlock.
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID, (ydoc) => {
        seedBlocks(ydoc, [{ type: "paragraph", content: "seeded" } as LoosePartialBlock]);
      });
    });

    // Editor-mutate then throw. The mutation should not leave a
    // doc_updates row behind, and the next read should not see the
    // rolled-back block. (Single-process no-WS; the `BoundSyncService.
    // rollback()` path inside dispatcher's runInWriteTx is what evicts
    // the resident Y.Doc — here we drive it explicitly via the bound
    // service since this test doesn't ride the dispatcher.)
    await expect(
      driver.withSystemTx(async (tx) => {
        const ctx: HocuspocusTxContext = {
          sqlTx: asAuditTx(tx),
          principal: testPrincipal(),
          workspace_id: WORKSPACE_ID,
        };
        const bound = sync.bind(ctx);
        try {
          await bound.transact(DOC_ID, (ydoc) => {
            const fragment = ydoc.getXmlFragment(BLOCKNOTE_FRAGMENT);
            const { editor, dispose } = liveEditor(fragment);
            try {
              const referenceId = editor.document[0]?.id;
              if (referenceId === undefined) throw new Error("no seeded block visible");
              editor.transact(() => {
                editor.insertBlocks(
                  [{ type: "paragraph", content: "rolled-back" } as LoosePartialBlock],
                  referenceId,
                  "after",
                );
              });
            } finally {
              dispose();
            }
          });
          throw new Error("post-transact throw");
        } catch (err) {
          await bound.rollback();
          throw err;
        }
      }),
    ).rejects.toThrow("post-transact throw");

    // Only the seed row landed; the editor-mutate row did not.
    const rows = await fetchDocUpdates(DOC_ID);
    expect(rows.map((r) => r.seq)).toEqual([1]);

    // Verify projection — the resident Y.Doc was evicted by rollback,
    // so the next ctx.transact rehydrates from committed doc_updates,
    // and the rolled-back block is invisible.
    // Verify projection: rehydrate path returns *exactly* the seeded
    // state — one block, no trailing empty (the live editor never
    // committed, so its normalisation tail was rolled back too).
    let projected: ReadonlyArray<LooseBlock> = [];
    await driver.withSystemTx(async (tx) => {
      const ctx: HocuspocusTxContext = {
        sqlTx: asAuditTx(tx),
        principal: testPrincipal(),
        workspace_id: WORKSPACE_ID,
      };
      const bound = sync.bind(ctx);
      await bound.transact(DOC_ID, (ydoc) => {
        projected = readBlocks(ydoc);
      });
    });
    expect(summarize(projected)).toEqual([["paragraph", "seeded"]]);
  });
});
