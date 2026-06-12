/**
 * Block JSON ⇄ ProseMirror doc JSON (ADR 0038).
 *
 * Pure structural mapping between the canonical block model
 * (`./model.ts`) and the JSON shape `Node.toJSON()` / `Node.fromJSON`
 * speak for the owned schema (`./tiptap.ts`). Both directions are
 * loud: an unsupported node/mark type or a malformed shape throws —
 * the platform's fidelity posture is "didn't round-trip" must never
 * be silent (same rule as the Markdown layer).
 *
 *   block {id, type, props, content, children: []}
 *     ⇄ node {type, attrs: {id, ...props}, content: [text-with-marks]}
 *
 *   StyledText styles {bold, italic, code}  ⇄  marks [{type: "bold"}…]
 *
 * Mark emit order is fixed (bold → italic → code) so the PM projection
 * of a given block is deterministic; the styles bag absorbs any mark
 * order on the way back, which keeps `pmDocToBlocks ∘ blocksToPmDoc`
 * an identity on canonical blocks (pinned by the round-trip property
 * test).
 *
 * `id` tolerance is asymmetric by design: a PM node with a `null` /
 * absent id maps to the `""` unminted sentinel (browser-created nodes
 * have no id until a `doc.update` insert round-trips); the server
 * read path (`@editorzero/sync.readBlocks`) asserts non-empty ids on
 * top of this mapping, because persisted content always carries them.
 */

import { type Block, normalizeContent, type StyledText, TEXT_STYLE_KEYS } from "./model";

interface PmMarkJSON {
  readonly type: string;
}

interface PmTextJSON {
  readonly type: "text";
  readonly text: string;
  readonly marks?: readonly PmMarkJSON[];
}

interface PmBlockNodeJSON {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly PmTextJSON[];
}

export interface PmDocJSON {
  readonly type: "doc";
  readonly content: readonly PmBlockNodeJSON[];
}

/** Block types the owned schema knows, with their non-id attr keys. */
const BLOCK_NODE_PROPS: Readonly<Record<string, readonly string[]>> = {
  paragraph: [],
  heading: ["level"],
};

// ── blocks → PM ─────────────────────────────────────────────────────────

export function blocksToPmDoc(blocks: readonly Block[]): PmDocJSON {
  return { type: "doc", content: blocks.map(blockToPmNode) };
}

function blockToPmNode(block: Block): PmBlockNodeJSON {
  const propKeys = BLOCK_NODE_PROPS[block.type];
  if (propKeys === undefined) {
    throw new Error(`blocksToPmDoc: unsupported block type "${block.type}"`);
  }
  if (block.children.length > 0) {
    throw new Error(
      `blocksToPmDoc: block "${block.id}" has children — nested blocks are not in the owned schema yet`,
    );
  }
  for (const key of Object.keys(block.props)) {
    if (!propKeys.includes(key)) {
      throw new Error(`blocksToPmDoc: block type "${block.type}" has unknown prop "${key}"`);
    }
  }
  const attrs: Record<string, unknown> = { id: block.id.length === 0 ? null : block.id };
  for (const key of propKeys) {
    if (block.props[key] !== undefined) attrs[key] = block.props[key];
  }
  const content = normalizeContent(block.content).map(styledTextToPmText);
  return content.length === 0 ? { type: block.type, attrs } : { type: block.type, attrs, content };
}

function styledTextToPmText(run: StyledText): PmTextJSON {
  const marks: PmMarkJSON[] = [];
  for (const key of TEXT_STYLE_KEYS) {
    if (run.styles[key] === true) marks.push({ type: key });
  }
  return marks.length === 0
    ? { type: "text", text: run.text }
    : { type: "text", text: run.text, marks };
}

// ── PM → blocks ─────────────────────────────────────────────────────────

export function pmDocToBlocks(json: unknown): Block[] {
  const doc = asRecord(json, "doc node");
  if (doc["type"] !== "doc") {
    throw new Error(`pmDocToBlocks: expected a "doc" root node, got "${String(doc["type"])}"`);
  }
  const content = doc["content"];
  if (content === undefined) return [];
  if (!Array.isArray(content)) {
    throw new Error("pmDocToBlocks: doc content must be an array");
  }
  return content.map((child) => pmNodeToBlock(child));
}

function pmNodeToBlock(json: unknown): Block {
  const node = asRecord(json, "block node");
  const type = node["type"];
  if (typeof type !== "string") {
    throw new Error("pmDocToBlocks: block node has no type");
  }
  const propKeys = BLOCK_NODE_PROPS[type];
  if (propKeys === undefined) {
    throw new Error(`pmDocToBlocks: unsupported block node type "${type}"`);
  }
  const attrs = node["attrs"] === undefined ? {} : asRecord(node["attrs"], "block attrs");
  const id = attrs["id"];
  const props: Record<string, unknown> = {};
  for (const key of propKeys) {
    if (attrs[key] !== undefined && attrs[key] !== null) props[key] = attrs[key];
  }
  const rawContent = node["content"];
  const content: StyledText[] = [];
  if (rawContent !== undefined) {
    if (!Array.isArray(rawContent)) {
      throw new Error(`pmDocToBlocks: content of "${type}" must be an array`);
    }
    for (const inline of rawContent) {
      content.push(pmTextToStyledText(inline));
    }
  }
  return {
    id: typeof id === "string" ? id : "",
    type,
    props,
    content,
    children: [],
  };
}

function pmTextToStyledText(json: unknown): StyledText {
  const node = asRecord(json, "inline node");
  if (node["type"] !== "text" || typeof node["text"] !== "string") {
    throw new Error(`pmDocToBlocks: unsupported inline node type "${String(node["type"])}"`);
  }
  const styles: Record<string, boolean> = {};
  const marks = node["marks"];
  if (marks !== undefined) {
    if (!Array.isArray(marks)) {
      throw new Error("pmDocToBlocks: marks must be an array");
    }
    for (const mark of marks) {
      const markNode = asRecord(mark, "mark");
      const markType = markNode["type"];
      if (typeof markType !== "string" || !isStyleKey(markType)) {
        throw new Error(`pmDocToBlocks: unsupported mark type "${String(markType)}"`);
      }
      styles[markType] = true;
    }
  }
  return { type: "text", text: node["text"], styles };
}

function isStyleKey(value: string): value is (typeof TEXT_STYLE_KEYS)[number] {
  return (TEXT_STYLE_KEYS as readonly string[]).includes(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`pmDocToBlocks: malformed ${what}`);
  }
  return value as Record<string, unknown>;
}
