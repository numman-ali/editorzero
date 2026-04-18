/**
 * Block kernel — fidelity-tier descriptor per block type (architecture.md §16.5, ADR 0013).
 *
 * `BlockTypeSpec` is editorzero's declaration for a custom block. It is
 * **not** BlockNote's `BlockSpec` type (`{ config, implementation,
 * extensions }` in `@blocknote/core`) — that's BlockNote's registration
 * shape; ours is the per-type Markdown round-trip contract declared
 * alongside each custom block. The renames documented in
 * architecture.md §16.5.
 *
 * The kernel is dep-light and runtime-free: only types + a passthrough
 * factory for inference. Concrete block specs (e.g., `editorzero:core/
 * heading`) land in sibling files and import this type. The `reactView`
 * half of each spec lives in `@editorzero/blocks/react` so the default
 * export does not force `@blocknote/react` into non-UI consumers (API
 * server, CLI, mirror job runner).
 */

import type { Block, BlockSchema, InlineContentSchema, StyleSchema } from "@blocknote/core";
import type { FidelityTier } from "@editorzero/scopes";
import type { RootContent } from "mdast";
import type { ZodType } from "zod";

/*
 * About the generic defaults below
 * --------------------------------
 * BlockNote ships `DefaultBlockSchema` whose `heading` entry has an
 * optional `isToggleable?: PropSpec` key, which does NOT satisfy
 * `BlockSchema`'s index signature `Record<string, PropSpec<...>>`
 * (required keys only). BlockNote's own `Block<BSchema = DefaultBlockSchema>`
 * only typechecks because library consumers build with
 * `skipLibCheck: true`. Our own source files are rechecked, so reusing
 * `DefaultBlockSchema` as a generic default here surfaces the mismatch
 * as TS2344.
 *
 * Workaround: default to the loose `BlockSchema` / `InlineContentSchema`
 * / `StyleSchema`. Concrete block specs that want the default-editor
 * type information pass `Block<DefaultBlockSchema, ...>` into their
 * callbacks explicitly — they still get BlockNote's narrowed types
 * inside `toMarkdown` / `fromMarkdown` bodies via `node.type === ...`
 * discriminants, which is what the fidelity property tests exercise
 * anyway. Revisit when BlockNote ships a `DefaultBlockSchema` that
 * satisfies its own constraint (watch upstream PRs around
 * `propTypes.d.ts`).
 */

/**
 * Block-level mdast node handed to `fromMarkdown`. `RootContent` is the
 * v4 discriminated union of all direct children of `Root` — paragraphs,
 * headings, lists, tables, code blocks, directives, etc. A concrete
 * spec narrows via type guards (e.g., `node.type === "heading"`).
 */
export type MdastBlockNode = RootContent;

/**
 * Declaration for one editorzero block type.
 *
 * Generic parameters mirror BlockNote's tri-schema:
 * - `Attrs`: the block's zod-typed attribute shape. Same schema feeds
 *   the editor's `propSchema`, the audit effect serializer, and the
 *   Markdown round-trip equivalence check — single source of truth per
 *   §1.1.
 * - `BSchema`, `ISchema`, `SSchema`: the project-level block / inline /
 *   style schemas this spec participates in. Default to the loose
 *   `BlockSchema` / `InlineContentSchema` / `StyleSchema` (see the
 *   commentary block above for why `Default*` cannot be the default). A
 *   spec that needs tighter typing inside its callbacks parameterizes
 *   explicitly, e.g. `BlockTypeSpec<HeadingAttrs, DefaultBlockSchema>`.
 */
export interface BlockTypeSpec<
  Attrs extends Record<string, unknown>,
  BSchema extends BlockSchema = BlockSchema,
  ISchema extends InlineContentSchema = InlineContentSchema,
  SSchema extends StyleSchema = StyleSchema,
> {
  /** Fully-qualified identifier, e.g. `"editorzero:core/heading"`. */
  readonly type: string;

  /** Round-trip fidelity tier (ADR 0013). */
  readonly tier: FidelityTier;

  /** Attribute schema — zod. Same instance every consumer reads. */
  readonly attributes: ZodType<Attrs>;

  /**
   * Render a live block to Markdown per the declared tier. A `lossless`
   * tier spec produces CommonMark that `fromMarkdown` can round-trip
   * back to the equivalent block; `directive` tier uses remark-directive
   * syntax; `opaque` embeds an HTML fence.
   */
  readonly toMarkdown: (block: Block<BSchema, ISchema, SSchema>) => string;

  /**
   * Parse an mdast block-level node into a block, or return `null` if
   * this spec does not claim the node. The first spec whose
   * `fromMarkdown` returns non-null wins; unclaimed nodes fall through
   * to the default paragraph fallback.
   */
  readonly fromMarkdown: (node: MdastBlockNode) => Block<BSchema, ISchema, SSchema> | null;

  /**
   * Optional semantic equivalence. Used by the fidelity property test
   * (§17.1 invariant 1) and by the reconcile diff (§6.6) so two blocks
   * differing only in non-semantic whitespace count as equal. Default:
   * structural deep equality via the attribute schema's comparison.
   */
  readonly equivalence?: (
    a: Block<BSchema, ISchema, SSchema>,
    b: Block<BSchema, ISchema, SSchema>,
  ) => boolean;
}

/**
 * Heterogeneous convenience alias for collections of specs that do not
 * need to preserve per-entry generics (the registry barrel, contract
 * tests). Consumers that need typed access to a specific spec's attrs
 * import the spec directly.
 */
export type AnyBlockTypeSpec = BlockTypeSpec<
  Record<string, unknown>,
  BlockSchema,
  InlineContentSchema,
  StyleSchema
>;

/**
 * Identity helper: forwards the argument unchanged, but lets TypeScript
 * infer `Attrs` from the zod `attributes` schema so concrete specs do
 * not have to spell out the generic at declaration site.
 *
 * @example
 * export const heading = createBlockTypeSpec({
 *   type: "editorzero:core/heading",
 *   tier: "lossless",
 *   attributes: z.object({ level: z.number().int().min(1).max(6) }),
 *   toMarkdown: (b) => "#".repeat(b.props.level) + " " + textOf(b),
 *   fromMarkdown: (n) => n.type === "heading" ? buildHeading(n) : null,
 * });
 */
export function createBlockTypeSpec<
  Attrs extends Record<string, unknown>,
  BSchema extends BlockSchema = BlockSchema,
  ISchema extends InlineContentSchema = InlineContentSchema,
  SSchema extends StyleSchema = StyleSchema,
>(
  spec: BlockTypeSpec<Attrs, BSchema, ISchema, SSchema>,
): BlockTypeSpec<Attrs, BSchema, ISchema, SSchema> {
  return spec;
}
