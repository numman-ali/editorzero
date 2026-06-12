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

import { type Extensions, getSchema, Mark, mergeAttributes, Node } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";

/** Heading levels the owned schema accepts — mirrors `headingAttributes`. */
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

const blockIdAttribute = {
  id: {
    default: null,
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
 * The owned extension set. A fresh array per call (extensions carry
 * per-editor state once bound); the members are module singletons.
 */
export function editorExtensions(): Extensions {
  return [EzDocument, EzText, EzParagraph, EzHeading, EzBold, EzItalic, EzCode];
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
