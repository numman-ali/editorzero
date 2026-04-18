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
 *
 * The "lossless" claim is at the *canonical-BlockNote-form* level:
 * adjacent text nodes with identical style bags are merged by
 * `mdastInlineToBlockNote` on import, because some emitter paths
 * (emphasis with boundary whitespace, see below) legitimately split
 * a single styled run to produce valid CommonMark. A round-trip
 * against an already-canonical input is a fixed point.
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
  if (styles.code === true) return emitCodeSpan(item.text);
  const escaped = escapeMarkdownText(item.text);
  if (styles.italic === true || styles.bold === true) {
    return wrapEmphasis(escaped, styles);
  }
  return escaped;
}

/**
 * Wrap `escaped` text in `*` / `**` delimiters, but move any leading
 * or trailing whitespace OUT of the delimiters. CommonMark requires
 * the character flanking an emphasis run to be a non-whitespace,
 * non-punctuation "left/right-flanking" delimiter — wrapping ` note `
 * as `* note *` does NOT parse as emphasis, so the styles would
 * silently disappear on a real CommonMark round-trip.
 *
 * Splitting whitespace outside the delimiters is the canonical
 * Markdown serializer move (prettier, remark-stringify). It costs
 * content-node-structure fidelity on the round-trip (a single
 * bolded ` word ` run comes back as three nodes: space, bold word,
 * space) — `mdastInlineToBlockNote` merges adjacent same-style nodes
 * on import, so the canonical form (BlockNote text editors don't
 * normally produce runs with leading/trailing whitespace carrying
 * style) is still a fixed point.
 */
function wrapEmphasis(escaped: string, styles: KnownStyles): string {
  const leadingMatch = /^\s+/.exec(escaped);
  const leading = leadingMatch?.[0] ?? "";
  const rest = escaped.slice(leading.length);
  const trailingMatch = /\s+$/.exec(rest);
  const trailing = trailingMatch?.[0] ?? "";
  const core = rest.slice(0, rest.length - trailing.length);
  // A run that is entirely whitespace has no emphasis-able core;
  // CommonMark would render `**  **` as literal asterisks, not a
  // strong span, so we drop the delimiters entirely.
  if (core.length === 0) return escaped;
  let wrapped = core;
  if (styles.italic === true) wrapped = `*${wrapped}*`;
  if (styles.bold === true) wrapped = `**${wrapped}**`;
  return `${leading}${wrapped}${trailing}`;
}

/**
 * Emit an inline code span that survives a round-trip through any
 * CommonMark parser, regardless of what the content contains.
 *
 * Rules applied (CommonMark spec §6.1):
 *   1. A run of N backticks opens a code span that closes at the next
 *      run of exactly N backticks. So if the content contains a run of
 *      M backticks, we choose a fence of M+1 backticks to avoid a
 *      premature close.
 *   2. When content begins OR ends with a backtick, we pad with a
 *      single space on both sides; CommonMark strips one space from
 *      each end ONLY if both ends have a space (and content isn't
 *      entirely spaces), which exactly reverses the padding.
 */
function emitCodeSpan(text: string): string {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const needsPad = text.startsWith("`") || text.endsWith("`");
  return needsPad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function longestBacktickRun(s: string): number {
  let max = 0;
  let current = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "`") {
      current += 1;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
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
 * markdown syntax inside a plain text node. `<` and `>` are included
 * because `<foo>` / `<https://...>` would otherwise trigger raw-HTML
 * or autolink parsing — neither of which the v1 lossless inline tier
 * supports (`mdastInlineToBlockNote` only recognizes `text` / `strong`
 * / `emphasis` / `inlineCode`). Escaping both flips the CommonMark
 * interpretation back to literal text, which the import path handles.
 * Anything heavier (HTML-escape, link-dest escape) is handled by the
 * inline types that own those shapes (link/image/etc., not yet in
 * scope).
 */
function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
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
  return mergeAdjacentSameStyle(out) as unknown as StyledText<StyleSchema>[];
}

/**
 * Emphasis splitting (`wrapEmphasis`), boundary-whitespace handling,
 * and CommonMark's own tokenization all produce cases where a single
 * styled run arrives as multiple adjacent text nodes with identical
 * style bags. Merging them here recovers the canonical BlockNote
 * shape (one node per styled run) so the round-trip is a fixed point
 * on canonical inputs.
 */
function mergeAdjacentSameStyle(items: RawStyledText[]): RawStyledText[] {
  const merged: RawStyledText[] = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (last !== undefined && sameStyles(last.styles, item.styles)) {
      merged[merged.length - 1] = { ...last, text: last.text + item.text };
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function sameStyles(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
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
