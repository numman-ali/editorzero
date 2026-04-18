/**
 * Shared inline serialisation for `editorzero:core/*` block specs.
 *
 * Walks BlockNote's `InlineContent[]` ⇄ a subset of mdast's inline
 * nodes. The subset matches what we can round-trip losslessly today
 * (architecture.md §16.5):
 *   - text (plain or styled)
 *   - bold → `strong`
 *   - italic → `emphasis`
 *   - code → `inlineCode` (leaf, mutually exclusive with other styles)
 *
 * Deliberately out of scope for v1 (these block-the-round-trip and
 * would need their own specs / tier escalations):
 *   - links, strikethrough, underline
 *   - `textColor` / `backgroundColor` / `textAlignment` block props
 *   - non-`text` inline items (custom inline content, footnote refs,
 *     images, etc.)
 *
 * Unsupported shapes throw rather than silently drop — the property
 * harness (Phase 3) depends on "didn't round-trip" being loud.
 */

import type { StyledText, StyleSchema } from "@blocknote/core";

// ── BlockNote → Markdown ─────────────────────────────────────────────────

export function inlineContentToMarkdown(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((item) => inlineItemToMarkdown(item)).join("");
}

function inlineItemToMarkdown(item: unknown): string {
  if (!isStyledText(item)) {
    throw new Error(
      `inlineItemToMarkdown: unsupported inline item shape; expected StyledText, got ${
        typeof item === "object" && item !== null && "type" in item
          ? String((item as { type: unknown }).type)
          : typeof item
      }`,
    );
  }
  const styles = item.styles as KnownStyles;
  // `inlineCode` is a leaf mdast node (cannot nest children); when the
  // text carries the `code` style, emit just the backtick wrapper and
  // drop any other styles. This is the lossless mdast mapping — a
  // round-trip of `**\`x\`**` collapses the strong outside code back
  // to plain code on parse, so emitting `**\`x\`**` here would not be
  // a fixed point of the round-trip. Future tiers can add style
  // passthrough if/when we adopt HTML-passthrough.
  if (styles.code === true) return `\`${item.text}\``;
  let out = escapeMarkdownText(item.text);
  if (styles.italic === true) out = `*${out}*`;
  if (styles.bold === true) out = `**${out}**`;
  return out;
}

/**
 * The style keys this module understands. Typing `styles` as a record
 * with these optional booleans (rather than `Record<string, unknown>`)
 * lets us write `styles.bold` instead of `styles["bold"]` — Biome's
 * `useLiteralKeys` rule flags the bracket form as unnecessary when
 * the property is statically knowable.
 */
type KnownStyles = {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

export function isStyledText(x: unknown): x is StyledText<StyleSchema> {
  return (
    typeof x === "object" &&
    x !== null &&
    "type" in x &&
    (x as { type: unknown }).type === "text" &&
    "text" in x &&
    typeof (x as { text: unknown }).text === "string"
  );
}

/**
 * CommonMark escape for the glyphs that would otherwise re-enter
 * markdown syntax inside a plain text node. Anything heavier
 * (HTML-escape, link-dest escape) is handled by the inline types that
 * own those shapes (link/image/etc., not yet in scope).
 */
function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_[\]])/g, "\\$1");
}

// ── Markdown → BlockNote ─────────────────────────────────────────────────

interface MdastText {
  readonly type: "text";
  readonly value: string;
}
interface MdastStrong {
  readonly type: "strong";
  readonly children: readonly MdastInline[];
}
interface MdastEmphasis {
  readonly type: "emphasis";
  readonly children: readonly MdastInline[];
}
interface MdastInlineCode {
  readonly type: "inlineCode";
  readonly value: string;
}
type MdastInline = MdastText | MdastStrong | MdastEmphasis | MdastInlineCode;

// The concrete runtime shape walk builds: plain object with text +
// a free-form `styles` bag. BlockNote's generic `Styles<StyleSchema>`
// evaluates to an all-undefined index signature when `StyleSchema`
// has no concrete keys (the default), which is structurally
// incompatible with our `{ bold: true, italic: true, ... }` runtime
// values. We produce that shape here and cast to `StyledText<StyleSchema>`
// at the boundary — the cast is safe because the block schema assigned
// to a live editor supplies the concrete StyleSchema whose keys match.
type RawStyledText = { type: "text"; text: string; styles: Record<string, boolean> };

export function mdastInlineToBlockNote(children: readonly unknown[]): StyledText<StyleSchema>[] {
  const out: RawStyledText[] = [];
  for (const child of children) {
    walkInline(child as MdastInline, {}, out);
  }
  return out as unknown as StyledText<StyleSchema>[];
}

function walkInline(
  node: MdastInline,
  styles: Record<string, boolean>,
  out: RawStyledText[],
): void {
  switch (node.type) {
    case "text":
      out.push({ type: "text", text: node.value, styles: { ...styles } });
      return;
    case "inlineCode":
      out.push({ type: "text", text: node.value, styles: { ...styles, code: true } });
      return;
    case "strong":
      for (const c of node.children) walkInline(c, { ...styles, bold: true }, out);
      return;
    case "emphasis":
      for (const c of node.children) walkInline(c, { ...styles, italic: true }, out);
      return;
    /* v8 ignore start -- @preserve: exhaustive switch; any unhandled inline
       type here is a parser producing a shape the v1 scope deliberately does
       not cover, so we throw loud instead of silently corrupting content. */
    default: {
      const unknownNode = node as { type: string };
      throw new Error(`mdastInlineToBlockNote: unsupported inline node type: ${unknownNode.type}`);
    }
    /* v8 ignore stop */
  }
}
