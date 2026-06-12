/**
 * `doc.update` wire + internal contract (ADR 0034) — the single source
 * the capability, the API route, and any other surface derive from.
 *
 * **Naming (ADR 0034).** Schema values are PascalCase + `Schema`
 * (`DocUpdateInputSchema`); types are PascalCase named from the
 * capability contract. A transform-bearing pair has four projections:
 *   - `DocUpdateWireInput`  = `z.input<DocUpdateInputSchema>`   (wire request)
 *   - `DocUpdateInput`      = `z.output<DocUpdateInputSchema>`  (branded handler input)
 *   - `DocUpdateOutput`     = `z.output<DocUpdateOutputSchema>` (branded response)
 *   - `DocUpdateWireOutput` = `z.input<DocUpdateOutputSchema>`  (wire response — RESERVED)
 * Export only the projections that have consumers; `DocUpdateWireOutput`
 * is the reserved name for the response-wire side — add it under that
 * name (never a `RawOutput`/`SerializedOutput` synonym) if ever needed.
 *
 * `z.input` of each schema is the wire shape (plain strings); the
 * `.transform()` narrows to the branded internal shape (`z.output`). The
 * capability uses these as `Capability<DocUpdateInput, DocUpdateOutput>`;
 * the route feeds `DocUpdateInputSchema` to `validator` (→ wire-typed
 * `hc` client, branded `c.req.valid`) and `DocUpdateOutputSchema` to
 * `resolver` + `.parse(result)`.
 *
 * **Per-op schemas are exported individually.** The capability re-derives
 * the op types (`InsertOp` / `UpdateOp` / `RemoveOp`) it feeds to the
 * applier fn signatures from `z.output<typeof InsertOpInputSchema>` etc.,
 * so each op-shape schema is part of the public surface, not a private
 * intermediate. The discriminated-union members rejected at the schema
 * level (the deferred `move` / `set_visibility` ops) live in the
 * capability header, not here — this file carries shape, not policy
 * narration.
 *
 * Branded-ID fields come from `../shared/ids`. The block-visibility enum
 * (`default` / `internal` / `public`) is DISTINCT from doc-visibility and
 * stays local — do NOT reach for `../shared/visibility`.
 */

import { z } from "zod";

import {
  BlockIdInputSchema,
  BlockIdOutputSchema,
  DocIdInputSchema,
  DocIdOutputSchema,
} from "../shared/ids";

// ── Input ────────────────────────────────────────────────────────────────
//
// Discriminated union on `op`. Strict object at every level — unknown
// keys anywhere in the op tree produce `unrecognized_keys` at the
// dispatcher's validation audit row.

/** Hex-encoded sha256 — 64 lowercase hex chars. Matches `stableHash` output. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "expect_prior_content_hash must be a 64-char lowercase hex sha256 digest",
});

// For `insert`: the block is a partial shape — minimum `{ type }` +
// optional `props` + optional `content` (string shorthand or styled
// runs). `content` + `props` stay `unknown` here: the owned block
// layer (`@editorzero/blocks` — attribute schemas + content
// normalization) is the runtime validator, and the schemas leaf does
// not mirror the block-type registry. `id` is deliberately not
// accepted on input — the handler mints the `BlockId` via
// `generateBlockId()` so invariant 3a (audit replay records every
// block id) holds regardless of caller behaviour.
export const InsertBlockInputSchema = z
  .object({
    type: z.string().min(1, "block.type is required"),
    props: z.record(z.string(), z.unknown()).optional(),
    content: z.unknown().optional(),
  })
  .strict();

// `UpdatePatchInputSchema` must carry at least one of `type` / `props` /
// `content` — an empty patch is a semantic no-op that we don't want to
// accept as a mutation: it would still produce a `doc_updates` write +
// bump `docs.updated_at` for a change that expresses nothing, which
// pollutes the audit log and the rate-limit budget. Reject at the
// schema level so the dispatcher's pre-validation audit row carries
// the reason.
export const UpdatePatchInputSchema = z
  .object({
    type: z.string().min(1).optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    content: z.unknown().optional(),
  })
  .strict()
  .refine(
    (patch) => patch.type !== undefined || patch.props !== undefined || patch.content !== undefined,
    { message: "patch must contain at least one of `type`, `props`, or `content`" },
  );

export const InsertOpInputSchema = z
  .object({
    op: z.literal("insert"),
    block: InsertBlockInputSchema,
    // `null` = insert at the top (placement "before" against block 0).
    // A caller-supplied `after_block_id` that doesn't exist in the doc
    // throws `NotFoundError{subject_kind: "block"}` at handler time —
    // can't be caught at schema level without a cross-row reference.
    after_block_id: BlockIdInputSchema.nullable(),
  })
  .strict();

export const UpdateOpInputSchema = z
  .object({
    op: z.literal("update"),
    block_id: BlockIdInputSchema,
    patch: UpdatePatchInputSchema,
    expect_prior_content_hash: Sha256HexSchema.optional(),
  })
  .strict();

export const RemoveOpInputSchema = z
  .object({
    op: z.literal("remove"),
    block_id: BlockIdInputSchema,
    expect_prior_content_hash: Sha256HexSchema.optional(),
  })
  .strict();

export const OpInputSchema = z.discriminatedUnion("op", [
  InsertOpInputSchema,
  UpdateOpInputSchema,
  RemoveOpInputSchema,
]);

export const DocUpdateInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
    ops: z.array(OpInputSchema).min(1, "ops must contain at least one op"),
  })
  .strict();

// ── Output ───────────────────────────────────────────────────────────────
//
// Echoes the applied ops in post-state form. Per-op shape mirrors the
// `doc.update_batch` audit effect variant; the handler projects 1:1 into
// `effectOnAllow` without a remap. Returning the applied shape (not
// just a success flag) lets callers chain follow-up calls without a
// re-fetch — especially agents, which benefit from the inserted block's
// minted `id` round-tripping on the same response.

export const BlockPostStateOutputSchema = z.object({
  id: BlockIdOutputSchema,
  doc_id: DocIdOutputSchema,
  type: z.string(),
  parent_block_id: BlockIdOutputSchema.nullable(),
  order_key: z.string(),
  content_json: z.unknown(),
  // Block-level visibility — DISTINCT from doc-visibility; do not share.
  visibility: z.enum(["default", "internal", "public"]),
});

export const AppliedInsertOutputSchema = z
  .object({
    op: z.literal("insert"),
    block: BlockPostStateOutputSchema,
    after_block_id: BlockIdOutputSchema.nullable(),
    parent_block_id: BlockIdOutputSchema.nullable(),
  })
  .strict();

export const AppliedUpdateOutputSchema = z
  .object({
    op: z.literal("update"),
    block_id: BlockIdOutputSchema,
    post: BlockPostStateOutputSchema,
  })
  .strict();

export const AppliedRemoveOutputSchema = z
  .object({
    op: z.literal("remove"),
    block_id: BlockIdOutputSchema,
    preimage: BlockPostStateOutputSchema,
  })
  .strict();

export const AppliedOpOutputSchema = z.discriminatedUnion("op", [
  AppliedInsertOutputSchema,
  AppliedUpdateOutputSchema,
  AppliedRemoveOutputSchema,
]);

export const DocUpdateOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  applied_ops: z.array(AppliedOpOutputSchema),
  updated_at: z.number(),
});

export type DocUpdateWireInput = z.input<typeof DocUpdateInputSchema>;
export type DocUpdateInput = z.output<typeof DocUpdateInputSchema>;
export type DocUpdateOutput = z.output<typeof DocUpdateOutputSchema>;
