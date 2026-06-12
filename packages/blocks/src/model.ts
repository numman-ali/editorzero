/**
 * Owned block JSON model (ADR 0038).
 *
 * This is editorzero's *canonical* content shape — the one `doc.get`
 * returns, `doc.update` ops carry, audit effects serialize, and the
 * Markdown specs consume. It deliberately keeps the styled-text form
 * (`{ type: "text", text, styles: { bold?, italic?, code? } }`) that
 * the platform's wire fixtures and ADR 0013 specs were built on: a
 * flat per-run style bag reads better for agents than ProseMirror's
 * nested mark arrays, and the PM projection is a mechanical transform
 * (`./pm.ts`). Before ADR 0038 these types aliased `@blocknote/core`'s
 * `Block`/`PartialBlock`; the shape survives, the dependency does not.
 *
 * `children` is always `[]` in v1 — the owned Tiptap schema has no
 * nested blocks yet — but stays in the shape so the wire contract is
 * forward-compatible with the nesting slice (parent/child landed in
 * the audit `BlockPostState` shape from day one).
 *
 * `id: ""` is the **unminted sentinel**: blocks created in a browser
 * editor have no server-minted `BlockId` until a `doc.update` insert
 * round-trips (the input schema deliberately rejects caller-supplied
 * ids — invariant 3a, the handler mints). Server-side reads assert
 * non-empty ids (`@editorzero/sync.readBlocks`); the diff treats `""`
 * as "this block is an insert".
 */

import { z } from "zod";

/** The three inline styles the v1 lossless tier covers (ADR 0013). */
export const TEXT_STYLE_KEYS = ["bold", "italic", "code"] as const;
export type TextStyleKey = (typeof TEXT_STYLE_KEYS)[number];

export type TextStyles = { readonly [K in TextStyleKey]?: boolean };

export interface StyledText {
  readonly type: "text";
  readonly text: string;
  readonly styles: TextStyles;
}

export interface Block {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly content: readonly StyledText[];
  readonly children: readonly Block[];
}

/**
 * Caller-facing partial shape: `content` accepts the string shorthand
 * (`"Title"` ≡ one unstyled run) that seeds and agent payloads use.
 * Optional fields carry explicit `| undefined` so zod-inferred shapes
 * (which emit present-but-undefined under `exactOptionalPropertyTypes`)
 * assign without a cast — same convention as `@editorzero/audit`'s
 * `SeedBlock`.
 */
export interface PartialBlockInput {
  readonly id?: string | undefined;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>> | undefined;
  readonly content?: unknown;
}

const StyledTextSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    styles: z
      .object({
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        code: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const ContentInputSchema = z.union([z.string(), z.array(StyledTextSchema)]);

/**
 * Normalize the content shorthand to the canonical `StyledText[]`:
 * `undefined` / `""` → `[]`; a string → one unstyled run; an array is
 * validated run-by-run (unknown inline shapes throw — fidelity stays
 * loud, never lossy-silent). Style keys explicitly set to `false` are
 * dropped so `{ bold: false }` and `{}` canonicalize identically —
 * the hash + diff layers depend on one spelling per style state.
 */
export function normalizeContent(content: unknown): StyledText[] {
  if (content === undefined) return [];
  const parsed = ContentInputSchema.parse(content);
  if (typeof parsed === "string") {
    return parsed.length === 0 ? [] : [{ type: "text", text: parsed, styles: {} }];
  }
  const runs: StyledText[] = [];
  for (const run of parsed) {
    if (run.text.length === 0) continue; // empty runs carry nothing — drop, never emit
    const styles: Record<string, boolean> = {};
    for (const key of TEXT_STYLE_KEYS) {
      if (run.styles[key] === true) styles[key] = true;
    }
    runs.push({ type: "text", text: run.text, styles });
  }
  return runs;
}

/**
 * Materialize a partial input into a canonical `Block`. The caller
 * decides id policy: seeds pass pre-minted ids (audit invariant 3a),
 * the op applier mints, the diff layer materializes with `id: ""`.
 */
export function materializeBlock(input: PartialBlockInput, id: string): Block {
  return {
    id,
    type: input.type,
    props: input.props === undefined ? {} : { ...input.props },
    content: normalizeContent(input.content),
    children: [],
  };
}

/**
 * Wire-parse for a persisted block list. `doc.get` carries `blocks` as
 * `z.unknown()[]` at the schemas leaf (the block union deliberately
 * stays out of `@editorzero/schemas` — its doc-comment points here);
 * browser/CLI consumers re-validate with THIS package so the runtime
 * contract has one home. Children are pinned empty (v1 has no
 * nesting); content re-runs `normalizeContent` so the parsed block is
 * canonical by construction (one spelling per style state — the hash
 * the browser stamps must match what the server computed).
 */
const WireBlockSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    props: z.record(z.string(), z.unknown()),
    content: z.array(StyledTextSchema),
    children: z.array(z.unknown()).length(0),
  })
  .strict();

export function parseBlocks(value: readonly unknown[]): Block[] {
  return value.map((entry) => {
    const raw = WireBlockSchema.parse(entry);
    return {
      id: raw.id,
      type: raw.type,
      props: raw.props,
      content: normalizeContent(raw.content),
      children: [],
    };
  });
}
