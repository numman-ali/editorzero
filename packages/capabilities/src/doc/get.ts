/**
 * `doc.get` — read a single doc's metadata and block projection
 * (architecture.md Appendix A § doc, §5 read-path projections,
 * §8.3(a) cross-workspace read example).
 *
 * Semantics:
 *   1. SELECT the `docs` row through `ctx.db` (tenant-scoped). A row
 *      missing, or present with `deleted_at IS NOT NULL`, becomes a
 *      `NotFoundError` — the soft-deleted state intentionally surfaces
 *      as 404, not 410: callers that hold restore permission use
 *      `doc.restore`'s explicit lookup path; plain `doc.get` treats
 *      trash as not-visible.
 *   2. Read the block array from the live Y.Doc via `ctx.transact`.
 *      Architecture.md §5 pins "real-time via Y.Doc" as the freshness
 *      guarantee for the block-array projection; going through
 *      `ctx.transact` keeps us on the sole-path contract (invariant 7
 *      + ADR 0018) — the same helper that mutations use. The callback
 *      returns a `LooseBlock[]` from `readBlocks` and does not mutate
 *      the Y.Doc; the `ctx.transact` at-most-once backstop (F92) is
 *      satisfied by the single call site.
 *
 * **Cross-workspace isolation.** The handler never mentions
 * `workspace_id`; the `WorkspaceScopingPlugin` injects the predicate
 * on the SELECT (F87 — alias- and join-aware). A doc in workspace B
 * is unreachable from a workspace-A `ctx.db` — the SELECT returns
 * zero rows, the handler throws `NotFoundError`, and the dispatcher
 * audits `{ kind: "error", error_code: "not_found" }`. The §8.3(a)
 * worked example describes a Layer-1 deny ahead of dispatch when
 * the caller specifies an explicit `AccessPath.workspace_id`; this
 * capability's input has no `AccessPath`, so Layer-2 scoping
 * enforces the isolation directly.
 *
 * **Audit — read-collapsible, per-doc bucket.** Reads collapse per
 * `AUDIT_READ_COLLAPSE_WINDOW_MS` (F93 — SSOT constant). Unlike
 * `doc.list` (constant key), two `doc.get` calls with different
 * `doc_id`s are different subjects and must NOT collapse together —
 * the `collapseKey` returns a doc-scoped bucket.
 *
 * **v1 limitation — block-array projection, no Markdown.** The
 * architecture's Appendix A row projects both a block-array JSON
 * (for the editor) and a rendered Markdown form (for `curl`-style
 * agents) via `doc.get_markdown` / `doc.get`'s markdown variant
 * (§15.2 MCP resources — both URIs are backed by `doc.get`). This
 * slice lands the block-array path only; the Markdown path ships
 * with ADR 0013 per-tier fidelity rollout (future slice). The
 * distinction is a separate capability / resource URI, not a
 * field on the output here.
 *
 * **v1 limitation — no `reconcile_base_token` issuance.** The §6.6
 * reconcile-base flow (F66/F73) issues an opaque token from the
 * `doc.get` / `doc.get_markdown` response so agent authoring can
 * reconcile against a server-known baseline. That requires the
 * `reconcile_bases` table (§3.18) and a system-owned INSERT from
 * the dispatcher tx — not part of this slice. The table's DDL is
 * deferred until `doc.update_from_markdown` lands; `doc.get` gains
 * the `reconcile_base_token` field at that point, not sooner.
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { InternalError, NotFoundError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type DocGetInput,
  DocGetInputSchema,
  type DocGetOutput,
  DocGetOutputSchema,
} from "@editorzero/schemas/doc/get";
import { readBlocks } from "@editorzero/sync";
import type * as Y from "yjs";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_GET_ID = CapabilityId("doc.get");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocGetInputSchema` / `DocGetOutputSchema` are the single source
// (ADR 0034), defined in `@editorzero/schemas/doc/get` and reused
// verbatim by the API route. `z.input` is the wire shape (plain
// strings); each branded-ID field's `.transform()` narrows to the
// branded internal shape — `DocGetInput` / `DocGetOutput`. The
// `doc_id` UUIDv7 rail runs BEFORE the `DocId` brand applies (so a
// malformed value is a clean zod 400, never an uncaught `DocId()`
// throw); the `blocks` field is `z.array(z.unknown())` because the
// BlockNote block union is owned by `@editorzero/sync`'s `readBlocks`,
// not mirrored into the schemas leaf — the dispatcher's output-parse
// is a structural pass-through for that field.

// ── Capability ───────────────────────────────────────────────────────────

export const docGet: Capability<DocGetInput, DocGetOutput> = {
  id: DOC_GET_ID,
  category: "read",
  summary: "Read a single doc's metadata and real-time block-array projection from the Y.Doc.",
  input: DocGetInputSchema,
  output: DocGetOutputSchema,
  requires: ["doc:read"],
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: DOC_GET_ID,
      required_scopes: ["doc:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(DOC_GET_ID, error),
    // Reads collapse per §9.3 — but each distinct `doc_id` is a
    // distinct bucket. A caller reading docs A and B in rapid
    // succession produces two audit rows (one per doc), not one
    // merged row; a caller reading doc A twice in the window
    // produces one row with `collapsed_count = 2`.
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      // `CollapsePolicy.collapseKey` is typed as `(input: unknown) =>
      // string` because the type lives in `@editorzero/audit` and
      // cannot see the per-capability `I`. The dispatcher only calls
      // it with a runtime-validated input of shape `DocGetInput`, so
      // the cast here is exactly as safe as the zod parse that ran
      // ahead of it.
      collapseKey: (input) => `doc.get:${(input as DocGetInput).doc_id}`,
    },
  },
  handler: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom("docs")
      .select([
        "id",
        "workspace_id",
        "collection_id",
        "title",
        "slug",
        "visibility",
        "created_at",
        "updated_at",
      ])
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (row === undefined) {
      // Soft-deleted docs are NOT visible through `doc.get` — the
      // `deleted_at IS NULL` predicate filters them out, and we
      // surface the same `not_found` to the caller as a genuinely
      // absent row. `doc.restore` holds the recovery path (invariant
      // 6); leaking "yes this exists but is trashed" through
      // `doc.get` would give a reader without `doc:delete` partial
      // visibility into trash. 404 is the honest projection.
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // Read-only `ctx.transact`: the callback projects the block
    // array and returns it; `readBlocks` never mutates the Y.Doc.
    // The kernel's `TEditor = unknown` default gives `editor` as
    // `unknown`; the same documented `as Y.Doc` cast `doc.create`
    // applies at the seed site applies here. A later sub-slice that
    // sharpens `TEditor` drops the cast without rewriting the body.
    const blocks = await ctx.transact(input.doc_id, (editor) => readBlocks(editor as Y.Doc));

    // **Fail closed on empty blocks for an existing docs row.**
    // `doc.create` seeds every new doc with a `heading` + `paragraph`
    // (header file: §Semantics) and there is no capability today that
    // can legitimately reduce a doc to zero blocks. So `blocks.length
    // === 0` here is never "the doc is genuinely empty" — it is a
    // state-inconsistency signal: the `docs` row persisted but the
    // Y.Doc state is gone. On the current `MemorySyncService` backend
    // this happens on process restart (in-memory Y.Docs evict; SQLite
    // `docs` rows survive). On the future Hocuspocus backend the same
    // failure mode would require a `doc_updates` loss against the
    // persisted composite FK (§3.5) — much harder, but not
    // architecturally impossible during an incident.
    //
    // Returning `blocks: []` silently would let a client load the
    // "doc" (header + 0 content), edit the empty canvas, and submit
    // a `doc.update` that OVERWRITES the real persisted state when a
    // durable sync backend comes back online. That is the data-loss
    // footgun Codex F105 P1 flagged. `InternalError` (500) is the
    // honest projection — the request isn't malformed (not 400) and
    // the doc isn't missing (not 404); the server's state is
    // internally inconsistent, an operator needs to investigate, and
    // the caller's correct response is to retry or escalate, not to
    // edit.
    if (blocks.length === 0) {
      throw new InternalError({
        message: `doc.get: docs row for ${input.doc_id} exists but Y.Doc fragment is empty; refusing to project blank content.`,
      });
    }

    return { doc: row, blocks };
  },
};
