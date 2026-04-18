/**
 * `@editorzero/blocks` — BlockTypeSpec kernel (architecture.md §16.5).
 *
 * This default export is runtime-free: types + a pass-through factory
 * for inference. Concrete block specs (e.g., `editorzero:core/heading`)
 * live in sibling files once they land; the React view half of each
 * spec will live in `@editorzero/blocks/react` to keep `@blocknote/
 * react` out of non-UI consumers' dep graph.
 */

export type { AnyBlockTypeSpec, BlockTypeSpec, MdastBlockNode } from "./kernel";
export { createBlockTypeSpec } from "./kernel";
