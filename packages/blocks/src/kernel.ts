/**
 * Block kernel — fidelity-tier descriptor per block type (architecture.md §16.5, ADR 0013).
 *
 * `BlockTypeSpec` is editorzero's declaration for a custom block: the
 * per-type Markdown round-trip contract declared alongside each block
 * type. Specs operate on the owned block model (`./model.ts`) — until
 * ADR 0038 they were typed against `@blocknote/core`'s tri-schema
 * generics (`Block<BSchema, ISchema, SSchema>` + the `LooseBlock`
 * workaround for its `exactOptionalPropertyTypes` mismatch); the owned
 * model collapses all of that to one concrete `Block`.
 *
 * The kernel is dep-light: types + a passthrough factory for
 * inference. Concrete block specs (`editorzero:core/heading`, …) live
 * in `./core/`; their editor projections (Tiptap nodes) live in
 * `./tiptap.ts`, and the PM mapping in `./pm.ts` — one block type, one
 * spec file per concern, all reading the same attribute schema.
 */

import type { FidelityTier } from "@editorzero/scopes";
import type { RootContent } from "mdast";
import type { ZodType } from "zod";

import type { Block } from "./model";

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
 * `Attrs` is the block's zod-typed attribute shape. The same schema
 * instance feeds the editor's prop handling, the `doc.update` applier's
 * merged-props parse, the audit effect serializer, and the Markdown
 * round-trip equivalence check — single source of truth per §1.1.
 */
export interface BlockTypeSpec<Attrs extends Record<string, unknown>> {
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
  readonly toMarkdown: (block: Block) => string;

  /**
   * Parse an mdast block-level node into a block, or return `null` if
   * this spec does not claim the node. The first spec whose
   * `fromMarkdown` returns non-null wins; unclaimed nodes fall through
   * to the default paragraph fallback.
   */
  readonly fromMarkdown: (node: MdastBlockNode) => Block | null;

  /**
   * Optional semantic equivalence. Used by the fidelity property test
   * (§17.1 invariant 1) and by the reconcile diff (§6.6) so two blocks
   * differing only in non-semantic whitespace count as equal. Default:
   * structural deep equality via the attribute schema's comparison.
   */
  readonly equivalence?: (a: Block, b: Block) => boolean;
}

/**
 * Heterogeneous convenience alias for collections of specs that do not
 * need to preserve per-entry generics (the registry barrel, contract
 * tests). Consumers that need typed access to a specific spec's attrs
 * import the spec directly.
 */
export type AnyBlockTypeSpec = BlockTypeSpec<Record<string, unknown>>;

/**
 * Identity helper: forwards the argument unchanged, but lets TypeScript
 * infer `Attrs` from the zod `attributes` schema so concrete specs do
 * not have to spell out the generic at declaration site.
 */
export function createBlockTypeSpec<Attrs extends Record<string, unknown>>(
  spec: BlockTypeSpec<Attrs>,
): BlockTypeSpec<Attrs> {
  return spec;
}
