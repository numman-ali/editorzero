/**
 * Owned Tiptap v3 extensions — THE document schema (ADR 0038).
 *
 * One extension set, two consumers: the browser editor instantiates a
 * Tiptap `Editor` over these, and the server derives the compiled
 * ProseMirror `Schema` via `getSchema(...)` for its DOM-free read /
 * write path (`@editorzero/sync`). Schema *compilation* is pure — the
 * `renderHTML` / `parseHTML` callbacks are stored, not executed, so
 * importing this module server-side never touches a DOM.
 *
 * Every node/mark is defined with `Node.create` / `Mark.create` from
 * `@tiptap/core` directly — no `@tiptap/extension-*` or starter-kit
 * packages. That is the "owned thin block layer": the schema is ours
 * to evolve (track-changes attrs, agent-attribution marks — ADR 0032)
 * without inheriting upstream churn.
 *
 * Shape notes:
 *   - Top-level blocks are FLAT (`doc → block+`); nesting is a future
 *     slice. Block identity is the `id` attribute (server-minted
 *     `BlockId`, `null` until first save for browser-created nodes),
 *     rendered as `data-block-id` in the DOM.
 *   - Two hygiene layers keep ids unique inside a live editor: the id
 *     attribute opts out of split-copying (`keepOnSplit: false` — Enter
 *     must mint, not clone) and `EzBlockIdHygiene` clears any duplicate
 *     that still lands (copy/paste re-parses `data-block-id`). The
 *     server refuses duplicate ids outright (`duplicate_block_id`) and
 *     mints ids for cleared ones — the client's job is only ever to
 *     SEND cleared ids, never to invent them.
 *   - Node names (`paragraph`, `heading`) are also the wire `type`
 *     values in the block JSON — `./pm.ts` maps 1:1.
 *   - The `code` mark excludes all other marks (`excludes: "_"`),
 *     matching the ADR 0013 lossless tier where inline code is a leaf:
 *     content that can't survive a Markdown round-trip can't be
 *     authored in the first place.
 *   - Keyboard shortcuts live on the marks (inert server-side).
 */

/// <reference lib="dom" />
// ^ type-only: the parseHTML callback signatures mention HTMLElement.
// Nothing in this module touches a DOM at runtime until an Editor
// mounts it in a browser.

import { Extension, type Extensions, getSchema, Mark, mergeAttributes, Node } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";

/** Heading levels the owned schema accepts — mirrors `headingAttributes`. */
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

const blockIdAttribute = {
  id: {
    default: null,
    // Splitting a block (Enter) copies attributes onto the new node by
    // default. A copied id is a DUPLICATE the server write gate refuses
    // (`duplicate_block_id`, @editorzero/sync foreign-update) — and on
    // the collab lane a refused update poisons the session: every
    // resync re-offers it until a full reload. The split-off block must
    // fall back to `default: null` → the `""` wire sentinel → the
    // server mints its id (the foreign-update repair lane).
    keepOnSplit: false,
    /* v8 ignore next 2 -- @preserve: runs only when a browser editor parses pasted/loaded DOM. */
    parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      typeof attributes["id"] === "string" ? { "data-block-id": attributes["id"] } : {},
  },
};

const EzDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",
});

const EzText = Node.create({
  name: "text",
  group: "inline",
});

const EzParagraph = Node.create({
  name: "paragraph",
  group: "block",
  content: "inline*",
  addAttributes() {
    return blockIdAttribute;
  },
  parseHTML() {
    return [{ tag: "p" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["p", HTMLAttributes, 0];
  },
});

const EzHeading = Node.create({
  name: "heading",
  group: "block",
  content: "inline*",
  addAttributes() {
    return {
      ...blockIdAttribute,
      level: {
        default: 1,
        /* v8 ignore next -- @preserve: runs only when a browser editor parses pasted/loaded DOM. */
        parseHTML: (element: HTMLElement) => Number(element.tagName.charAt(1)),
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return HEADING_LEVELS.map((level) => ({ tag: `h${level}` }));
  },
  renderHTML({ node, HTMLAttributes }) {
    const level = HEADING_LEVELS.find((l) => l === node.attrs["level"]) ?? 1;
    return [`h${level}`, HTMLAttributes, 0];
  },
});

const EzBold = Mark.create({
  name: "bold",
  parseHTML() {
    return [{ tag: "strong" }, { tag: "b" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["strong", mergeAttributes(HTMLAttributes), 0];
  },
  /* v8 ignore start -- @preserve: needs a live `this.editor`; exercised by the app e2e suite. */
  addKeyboardShortcuts() {
    return {
      "Mod-b": () => this.editor.commands.toggleMark(this.name),
    };
  },
  /* v8 ignore stop */
});

const EzItalic = Mark.create({
  name: "italic",
  parseHTML() {
    return [{ tag: "em" }, { tag: "i" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["em", mergeAttributes(HTMLAttributes), 0];
  },
  /* v8 ignore start -- @preserve: needs a live `this.editor`; exercised by the app e2e suite. */
  addKeyboardShortcuts() {
    return {
      "Mod-i": () => this.editor.commands.toggleMark(this.name),
    };
  },
  /* v8 ignore stop */
});

const EzCode = Mark.create({
  name: "code",
  excludes: "_",
  parseHTML() {
    return [{ tag: "code" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["code", mergeAttributes(HTMLAttributes), 0];
  },
  /* v8 ignore start -- @preserve: needs a live `this.editor`; exercised by the app e2e suite. */
  addKeyboardShortcuts() {
    return {
      "Mod-e": () => this.editor.commands.toggleMark(this.name),
    };
  },
  /* v8 ignore stop */
});

/**
 * Duplicate-block-id backstop. `keepOnSplit: false` on the id attribute
 * kills the split vector at the source, but a live editor can still
 * duplicate an id: copy/paste re-parses `data-block-id` from the
 * clipboard HTML straight back into the doc. The server refuses any
 * update whose post-apply tree repeats an id (`duplicate_block_id`),
 * and on the collab lane a refused update poisons the session until a
 * full reload — so duplicates must die client-side, before the y-sync
 * plugin ships them.
 *
 * After every doc-changing transaction, walk the top-level blocks and
 * clear (null) the id of every block whose id already appeared — first
 * occurrence in doc order keeps it. A cleared id serializes as the `""`
 * wire sentinel and the server mints a fresh `BlockId`, so a pasted
 * copy becomes a legitimate new block. Cut/paste (a move) is untouched:
 * the original is gone by paste time, the id stays unique and survives
 * — identity follows the move, history stays attached.
 *
 * The top-level walk matches the flat `doc → block+` shape; a future
 * nesting slice must extend it to descendants.
 *
 * Exported as a factory so unit tests exercise it DOM-free (plain
 * `EditorState.create` + `apply`); `EzBlockIdHygiene` mounts it in the
 * browser editor. `getSchema` never calls `addProseMirrorPlugins`, so
 * the server's schema path is untouched.
 */
export function blockIdHygienePlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const seen = new Set<string>();
      let fix: Transaction | null = null;
      newState.doc.forEach((node, offset) => {
        const id: unknown = node.attrs["id"];
        if (typeof id !== "string" || id === "") return;
        if (seen.has(id)) {
          fix ??= newState.tr;
          fix.setNodeAttribute(offset, "id", null);
          return;
        }
        seen.add(id);
      });
      return fix;
    },
  });
}

/* v8 ignore start -- @preserve: instantiated only by a live browser Editor; the plugin body is unit-tested via blockIdHygienePlugin(). */
const EzBlockIdHygiene = Extension.create({
  name: "blockIdHygiene",
  addProseMirrorPlugins() {
    return [blockIdHygienePlugin()];
  },
});
/* v8 ignore stop */

/**
 * The owned extension set. A fresh array per call (extensions carry
 * per-editor state once bound); the members are module singletons.
 */
export function editorExtensions(): Extensions {
  return [EzDocument, EzText, EzParagraph, EzHeading, EzBold, EzItalic, EzCode, EzBlockIdHygiene];
}

let compiledSchema: Schema | undefined;

/**
 * Compiled ProseMirror schema for DOM-free server use (`Node.fromJSON`,
 * `yXmlFragmentToProseMirrorRootNode`). Cached — schema identity
 * matters to ProseMirror (`instanceof` checks across nodes).
 */
export function getEditorSchema(): Schema {
  if (compiledSchema === undefined) {
    compiledSchema = getSchema(editorExtensions());
  }
  return compiledSchema;
}
