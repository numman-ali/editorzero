/**
 * `doc.apply_update` wire + internal contract (ADR 0034 / ADR 0043
 * Decision 2) — the single source the capability, the API route, and the
 * WS adapter's dispatch derive from.
 *
 * **Naming (ADR 0034).** Same four-projection convention as
 * `doc/update.ts`; only the projections with consumers are exported.
 *
 * **The `update` field stays a base64 STRING through the schema.** The
 * decoded form (`Uint8Array`) is a non-JSON type, which ADR 0034's
 * wire-preserving-transforms constraint excludes from schema-level
 * `.transform()` — the capability handler owns the decode (via
 * `@editorzero/sync`'s `base64ToBytes`), so the one schema serves the
 * JSON body, the CLI flag, and the MCP tool argument without per-surface
 * copies. The regex + `% 4` refinement make the handler-side decode
 * total: every accepted string is well-formed RFC 4648 base64.
 *
 * **Size cap.** A Yjs update for a document is bounded by document size,
 * not edit size, only on first sync — steady-state deltas are tiny. The
 * cap exists so a hostile caller cannot push an arbitrarily large blob
 * into memory/`doc_updates`; 10 MiB of decoded update is far beyond any
 * legitimate single-doc payload we support today (snapshots compact the
 * log before docs grow anywhere near it) while staying cheap to parse.
 * Expressed in base64 characters so zod enforces it before decode.
 */

import { z } from "zod";

import { BlockIdOutputSchema, DocIdInputSchema, DocIdOutputSchema } from "../shared/ids";

// ── Input ────────────────────────────────────────────────────────────────

/** 10 MiB of decoded bytes, expressed as the base64 char budget: ceil(10·2²⁰ / 3) · 4. */
export const MAX_UPDATE_BASE64_CHARS = 13_981_016;

/**
 * Standard (RFC 4648) padded base64. The alphabet regex rejects URL-safe
 * variants and embedded whitespace; the `% 4` refinement rejects
 * truncation. Together they make `base64ToBytes` total — no decode-time
 * error lane in the handler.
 */
export const YjsUpdateBase64Schema = z
  .string()
  .min(1, "update must not be empty")
  .max(MAX_UPDATE_BASE64_CHARS, "update exceeds the 10 MiB decoded-size cap")
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, {
    message: "update must be standard padded base64 (RFC 4648)",
  })
  .refine((value) => value.length % 4 === 0, {
    message: "update must be padded base64 (length divisible by 4)",
  });

export const DocApplyUpdateInputSchema = z
  .object({
    doc_id: DocIdInputSchema,
    update: YjsUpdateBase64Schema,
  })
  .strict();

// ── Output ───────────────────────────────────────────────────────────────
//
// `applied: false` is the marked no-op lane (ADR 0043 Decision 2): the
// update was fully contained in the doc's current state (provider
// re-send, handshake echo, or the preflight/apply race), so nothing was
// persisted and `update_b64` is `null`. When `applied: true`,
// `update_b64` carries the EXACT merged post-repair blob that was
// persisted to `doc_updates` — the audit effect projects from this
// output, so the output must carry the handler-computed truth (never the
// caller's input, which the id-repair step may have extended).

export const DocApplyUpdateOutputSchema = z.object({
  doc_id: DocIdOutputSchema,
  applied: z.boolean(),
  update_b64: z.string().nullable(),
  minted_block_ids: z.array(BlockIdOutputSchema),
  updated_at: z.number(),
});

export type DocApplyUpdateWireInput = z.input<typeof DocApplyUpdateInputSchema>;
export type DocApplyUpdateInput = z.output<typeof DocApplyUpdateInputSchema>;
export type DocApplyUpdateOutput = z.output<typeof DocApplyUpdateOutputSchema>;
