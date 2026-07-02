/**
 * Owned Tiptap schema — compiled-shape assertions + DOM-free execution
 * of the `renderHTML` paths.
 *
 * `getSchema` stores `renderHTML` callbacks inside each type's
 * `spec.toDOM`; calling `toDOM` returns a `DOMOutputSpec` *array* —
 * pure data — so the render path (node renderHTML + per-attribute
 * renderHTML, e.g. `data-block-id`) executes here without any DOM,
 * exactly as documented in the module header.
 */

import { getAttributesFromExtensions } from "@tiptap/core";
import type { MarkType, NodeType, Mark as PmMark, Node as PmNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { blockIdHygienePlugin, editorExtensions, getEditorSchema, HEADING_LEVELS } from "./tiptap";

const schema = getEditorSchema();

function nodeType(name: string): NodeType {
  const type = schema.nodes[name];
  if (type === undefined) throw new Error(`schema is missing node "${name}"`);
  return type;
}

function markType(name: string): MarkType {
  const type = schema.marks[name];
  if (type === undefined) throw new Error(`schema is missing mark "${name}"`);
  return type;
}

function renderNode(name: string, attrs: Record<string, unknown>): unknown {
  const type = nodeType(name);
  const toDOM = type.spec.toDOM;
  if (toDOM === undefined) throw new Error(`node "${name}" has no toDOM`);
  return toDOM(type.create(attrs));
}

function renderMark(name: string): unknown {
  const type = markType(name);
  const toDOM = type.spec.toDOM;
  if (toDOM === undefined) throw new Error(`mark "${name}" has no toDOM`);
  const mark: PmMark = type.create();
  return toDOM(mark, true);
}

describe("compiled schema shape", () => {
  it("has exactly the owned nodes and marks, doc on top", () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(["doc", "heading", "paragraph", "text"]);
    expect(Object.keys(schema.marks).sort()).toEqual(["bold", "code", "italic"]);
    expect(schema.topNodeType.name).toBe("doc");
    expect(nodeType("doc").spec.content).toBe("block+");
    expect(nodeType("paragraph").spec.content).toBe("inline*");
  });

  it("code excludes all other marks (ADR 0013 leaf tier)", () => {
    expect(markType("code").spec.excludes).toBe("_");
  });

  it("parses h1–h6 into heading and p into paragraph", () => {
    const tags = (name: string): string[] =>
      (nodeType(name).spec.parseDOM ?? []).map((rule) => ("tag" in rule ? (rule.tag ?? "") : ""));
    expect(tags("heading")).toEqual(HEADING_LEVELS.map((level) => `h${level}`));
    expect(tags("paragraph")).toEqual(["p"]);
  });

  it("getEditorSchema caches (ProseMirror needs schema identity)", () => {
    expect(getEditorSchema()).toBe(schema);
  });

  it("editorExtensions returns a fresh array per call over the same members", () => {
    const a = editorExtensions();
    const b = editorExtensions();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("renderHTML via spec.toDOM (DOM-free)", () => {
  it("renders paragraph with data-block-id when the id is minted", () => {
    expect(renderNode("paragraph", { id: "018f-p1" })).toEqual([
      "p",
      { "data-block-id": "018f-p1" },
      0,
    ]);
  });

  it("renders paragraph without the attribute while the id is null", () => {
    expect(renderNode("paragraph", { id: null })).toEqual(["p", {}, 0]);
  });

  it("renders heading into its level tag", () => {
    expect(renderNode("heading", { id: "018f-h1", level: 3 })).toEqual([
      "h3",
      { "data-block-id": "018f-h1" },
      0,
    ]);
  });

  it("falls back to h1 for an out-of-range level attr", () => {
    expect(renderNode("heading", { id: null, level: 9 })).toEqual(["h1", {}, 0]);
  });

  it("renders the marks to strong / em / code", () => {
    expect(renderMark("bold")).toEqual(["strong", {}, 0]);
    expect(renderMark("italic")).toEqual(["em", {}, 0]);
    expect(renderMark("code")).toEqual(["code", {}, 0]);
  });
});

describe("block id hygiene", () => {
  function paragraphWithId(id: string | null, text: string): PmNode {
    return nodeType("paragraph").create({ id }, text === "" ? undefined : schema.text(text));
  }

  function stateWithPlugin(paragraphs: PmNode[]): EditorState {
    return EditorState.create({
      doc: nodeType("doc").create(null, paragraphs),
      plugins: [blockIdHygienePlugin()],
    });
  }

  it("pins keepOnSplit: false on the id attribute — Enter must mint, not clone", () => {
    // getSplittedAttributes (the helper tiptap's splitBlock uses) keeps
    // exactly the attributes whose keepOnSplit resolves true, so this
    // pins the split behavior without a live editor.
    const idAttributes = getAttributesFromExtensions(editorExtensions()).filter(
      (extensionAttribute) => extensionAttribute.name === "id",
    );
    expect(idAttributes.map((extensionAttribute) => extensionAttribute.type).sort()).toEqual([
      "heading",
      "paragraph",
    ]);
    for (const extensionAttribute of idAttributes) {
      expect(extensionAttribute.attribute.keepOnSplit).toBe(false);
    }
  });

  it("clears a pasted duplicate id after the doc change — first occurrence keeps it", () => {
    const state = stateWithPlugin([
      paragraphWithId("blk-a", "one"),
      paragraphWithId("blk-b", "two"),
    ]);
    // Paste-shaped change: a copy of blk-a lands at the end of the doc.
    const tr = state.tr.insert(state.doc.content.size, paragraphWithId("blk-a", "one copy"));
    const next = state.apply(tr);
    expect(next.doc.childCount).toBe(3);
    expect(next.doc.child(0).attrs["id"]).toBe("blk-a");
    expect(next.doc.child(1).attrs["id"]).toBe("blk-b");
    // Cleared, not re-invented: null → "" wire sentinel → server mints.
    expect(next.doc.child(2).attrs["id"]).toBeNull();
    expect(next.doc.child(2).textContent).toBe("one copy");
  });

  it("clears every later duplicate when an id repeats more than twice", () => {
    const state = stateWithPlugin([paragraphWithId("blk-a", "one")]);
    const tr = state.tr;
    tr.insert(tr.doc.content.size, paragraphWithId("blk-a", "two"));
    tr.insert(tr.doc.content.size, paragraphWithId("blk-a", "three"));
    const next = state.apply(tr);
    expect(next.doc.child(0).attrs["id"]).toBe("blk-a");
    expect(next.doc.child(1).attrs["id"]).toBeNull();
    expect(next.doc.child(2).attrs["id"]).toBeNull();
  });

  it("leaves unique ids and unminted (null / empty-sentinel) ids untouched", () => {
    const state = stateWithPlugin([
      paragraphWithId("blk-a", "one"),
      paragraphWithId(null, "draft"),
    ]);
    const tr = state.tr;
    tr.insert(tr.doc.content.size, paragraphWithId(null, "another draft"));
    tr.insert(tr.doc.content.size, paragraphWithId("", "sentinel"));
    const next = state.apply(tr);
    expect(next.doc.child(0).attrs["id"]).toBe("blk-a");
    expect(next.doc.child(1).attrs["id"]).toBeNull();
    expect(next.doc.child(2).attrs["id"]).toBeNull();
    expect(next.doc.child(3).attrs["id"]).toBe("");
  });

  it("appends nothing when the transaction does not change the doc", () => {
    const state = stateWithPlugin([paragraphWithId("blk-a", "one")]);
    const next = state.apply(state.tr);
    // Same doc object — no corrective transaction fired.
    expect(next.doc).toBe(state.doc);
  });
});
