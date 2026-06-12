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

import type { MarkType, NodeType, Mark as PmMark } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { editorExtensions, getEditorSchema, HEADING_LEVELS } from "./tiptap";

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
