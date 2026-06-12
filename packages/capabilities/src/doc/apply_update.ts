/**
 * `doc.apply_update` — the raw-delta content capability (ADR 0043
 * Decision 2). Carries every WS-originated content mutation once the WS
 * adapter lands (Decision 3), and — by invariant 4 — gives agents the
 * same raw Yjs push over HTTP/CLI/MCP: a Yjs-native agent can sync a
 * local doc without re-deriving block ops.
 *
 * **Coexistence with `doc.update`.** `doc.update` is the semantic lane
 * (block ops in, post-states out, `doc.update_batch` audit effect);
 * `doc.apply_update` is the protocol lane (opaque delta in, exact
 * persisted blob out). Both flow through the same `ctx.transact`
 * write-path tx, the same scopes, and the same ceiling — a caller gains
 * nothing by switching lanes.
 *
 * **Validation + repair live in `@editorzero/sync`'s
 * `applyForeignUpdate`** (§16.1 — Y.Doc surgery stays inside sync):
 * integrability (apply must not throw, must not leave pending
 * structs/deletes), owned-namespace exactness (share map ⊆
 * {DOC_FRAGMENT} — review SHOULD-FIX 3), the structural check under the
 * owned editor schema, duplicate-id refusal, and the id-less-block
 * repair (server-minted `BlockId`s captured into the SAME blob). Every
 * refusal throws `ForeignUpdateRefusedError` inside the transact fn —
 * the SQL tx aborts, the binding stages nothing, the resident never
 * sees the delta — and this handler maps it to `ValidationError` (400)
 * with structured `{ reason, detail }` issues.
 *
 * **The audit effect carries handler-computed truth (review MUST-FIX
 * 2).** The output's `update_b64` is the EXACT merged post-repair blob
 * the binding persisted (byte-identical by the listener-bracket contract
 * in `foreign-update.ts`), and `effectOnAllow` projects from the output
 * — never from the caller's input, which the repair step may have
 * extended. Replaying the non-null effect blobs in audit order
 * reconstructs the fragment (invariant 3).
 *
 * **The no-op lane is marked, not suppressed.** A fully-contained
 * update (provider re-send, handshake echo, preflight/apply race) fires
 * no Yjs events: nothing persists, the output says `applied: false,
 * update_b64: null`, and the allow row records exactly that. The WS
 * adapter preflights containment so steady-state sync chatter never
 * reaches dispatch; the residual race lands here and stays honest. The
 * `updated_at` bridge bumps even on the no-op — the UPDATE-first 404
 * probe IS the bump (same statement), and a contained re-send bumping
 * row freshness is accepted (ADR 0043).
 *
 * **Scopes.** `doc:write` + `block:write` + the Step-6 ceiling
 * (`assertCanRead`) — exact parity with `doc.update`'s posture. The
 * role-aware `canWrite` ladder is a named ADR 0043 non-goal; it narrows
 * every content mutation in one coordinated increment, not per-lane.
 *
 * **Surfaces at birth: api/cli/mcp.** The `ui` cell arrives with the
 * SPA collab-provider slice (the live editor over WS is the proof);
 * until then it is an honest `UI_PENDING` row in the parity matrix.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError, ValidationError } from "@editorzero/errors";
import { type BlockId, CapabilityId, generateBlockId } from "@editorzero/ids";
import {
  type DocApplyUpdateInput,
  DocApplyUpdateInputSchema,
  type DocApplyUpdateOutput,
  DocApplyUpdateOutputSchema,
} from "@editorzero/schemas/doc/apply_update";
import {
  applyForeignUpdate,
  base64ToBytes,
  bytesToBase64,
  ForeignUpdateRefusedError,
} from "@editorzero/sync";
import type * as Y from "yjs";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_APPLY_UPDATE_ID = CapabilityId("doc.apply_update");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocApplyUpdateInputSchema` / `DocApplyUpdateOutputSchema` are the
// single source (ADR 0034), reused verbatim by the API route and the WS
// adapter's dispatch. The `update` field stays a base64 STRING through
// the schema (decoded bytes are a non-JSON type — ADR 0034's
// wire-preserving-transforms constraint); the schema's alphabet + `% 4`
// refinements make the decode below total.

type Input = DocApplyUpdateInput;
type Output = DocApplyUpdateOutput;

// ── Capability ───────────────────────────────────────────────────────────

export const docApplyUpdate: Capability<Input, Output> = {
  id: DOC_APPLY_UPDATE_ID,
  category: "mutation",
  summary: "Apply a raw Yjs update to a doc's CRDT content (validated, id-repaired, audited).",
  input: DocApplyUpdateInputSchema,
  output: DocApplyUpdateOutputSchema,
  requires: ["doc:write", "block:write"],
  agentAllowed: {},
  // The `ui` cell lands with the SPA collab-provider slice (ADR 0043
  // Decision 2) — the live editor over WS is its proving spec.
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.apply_update",
      doc_id: output.doc_id,
      // Handler-computed truth: the exact persisted post-repair blob
      // (null = the marked no-op lane), never the caller's input.
      update_b64: output.update_b64,
      minted_block_ids: [...output.minted_block_ids],
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_APPLY_UPDATE_ID,
      required_scopes: ["doc:write", "block:write"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_APPLY_UPDATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 0 — ceiling pre-read (ADR 0040 Step 6). Content capability:
    // ctx.db is the plain auto-commit handle, so the deny must land
    // before the UPDATE below (no tx to roll it back) and before any
    // Y.Doc mutation.
    const doc = await ctx.db
      .selectFrom("docs")
      .select(["id", "created_by", "access_mode", "collection_id"])
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (doc === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanRead(doc);

    // Step 1 — UPDATE-first for 404 short-circuit + updated_at bump.
    // Same pattern as `doc.update`; the bump lands even when the delta
    // turns out to be a contained no-op (the probe IS the bump —
    // accepted, see file header).
    const row = await ctx.db
      .updateTable("docs")
      .set({ updated_at: now })
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .returning(["id", "updated_at"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // Step 2 — decode (total: the schema guarantees well-formed padded
    // base64) and run the foreign-update lane on the transact clone.
    // `applyForeignUpdate` is the ONLY mutation inside the fn — the
    // listener-bracket contract that makes the returned blob
    // byte-identical to what the binding persists. Minted ids are
    // captured branded through the closure (no re-parse, no cast).
    const update = base64ToBytes(input.update);
    const minted_block_ids: BlockId[] = [];
    let applied = false;
    let update_b64: string | null = null;
    try {
      await ctx.transact(input.doc_id, async (editor) => {
        // Kernel `TEditor` is still `unknown` (kernel.ts header); the
        // single documented cast narrows to Y.Doc here, same dance
        // `doc.create` / `doc.rename` / `doc.update` use.
        const ydoc = editor as Y.Doc;
        const result = applyForeignUpdate(ydoc, update, {
          mintId: () => {
            const id = generateBlockId();
            minted_block_ids.push(id);
            return id;
          },
        });
        if (result.applied) {
          applied = true;
          update_b64 = bytesToBase64(result.update);
        }
      });
    } catch (err) {
      if (err instanceof ForeignUpdateRefusedError) {
        // Domain-invariant violation reported as input-shaped (the
        // sanctioned ValidationError use): the payload parsed fine but
        // the DELTA is unacceptable. The transact fn threw, so the SQL
        // tx aborts and the binding stages nothing.
        throw new ValidationError({
          message: err.message,
          issues: [{ reason: err.reason, detail: err.detail }],
        });
      }
      throw err;
    }

    return {
      doc_id: row.id,
      applied,
      update_b64,
      minted_block_ids,
      updated_at: row.updated_at,
    };
  },
};
