/**
 * `doc.publish` — set a doc's `visibility` to `"public"` (architecture.md
 * Appendix A § doc; `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`).
 *
 * Metadata-only mutation: no `ctx.transact`, no Y.Doc touching, no
 * `doc_updates` row. Single UPDATE on the `docs` row. Idempotent at the
 * state level (`visibility` lands on `"public"` regardless of prior
 * value); `visibility_version` bumps on every successful invocation so
 * cache keyed on the version invalidates even when the caller re-asserts
 * an already-public state (F5 — the version is a stable signal that
 * *something* happened, not a change-detector).
 *
 * **Scope.** `doc:publish`. Distinct from `doc:write` so platform members
 * (who hold `doc:write` for authoring) can't trivially widen visibility —
 * that requires a deliberate role grant. Matches the matrix's split at
 * the `editor` agent tier (`AGENT_SCOPE_TIERS` in `@editorzero/scopes`).
 *
 * **Soft-deleted handling.** A `deleted_at IS NOT NULL` doc returns 404,
 * same as `doc.get` — publishing a trashed doc has no defined meaning and
 * should surface as "not found" to the caller. Callers that hold
 * `doc:delete` scope use `doc.restore` first; `doc.publish` is visibility,
 * not resurrection.
 *
 * **Audit effect.** `{ kind: "doc.publish", doc_id, published_at }`.
 * `published_at` is `ctx.now()` — the same timestamp written to
 * `docs.updated_at`. The audit row carries this; the `docs` row does NOT
 * yet — see "v1 scope" below.
 *
 * **v1 scope — visibility-only slice; `published_slug` + `published_at`
 * columns deferred.** Architecture.md §3 / Appendix A calls for the
 * `docs` row to carry `published_slug` + `published_at` (and for a
 * public-route renderer keyed on `(workspace_id, published_slug,
 * visibility_version)`). Neither column exists in the current DDL
 * (`packages/db/src/schema.ts` → `DocsTable`). Rather than widen the
 * DDL + backfill plan + public-route behaviour in this capability's
 * commit, this slice lands the **capability + route shape** only:
 * visibility flip to `"public"`, `visibility_version` bump, audit-row
 * emit. The DDL + public-route substrate land in the public read-path
 * renderer slice (the inverse capability `doc.unpublish` already
 * shipped alongside this one with the same deferral posture); at that
 * point this handler's UPDATE grows to set `published_slug = slug` +
 * `published_at = now` in the same statement, and `doc.get_markdown`'s
 * public-route uses `published_slug` as the URL key. No handler logic
 * from this file is load-bearing for that transition; the callers of
 * this route (the capability registry + OpenAPI doc + `hc<AppType>`
 * RPC) don't see a breaking change when those fields appear on the
 * response.
 *
 * **v1 limitation — no read-path enforcement of `"public"`.** Same
 * reason as above: `doc.list` / `doc.get` return every non-deleted doc
 * in the workspace regardless of visibility (no per-doc visibility
 * filter, no anonymous principal yet). Publishing a doc today only
 * updates the audit trail and the `visibility_version` — observable
 * effect on reads lands with the public-route slice.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type DocPublishInput,
  DocPublishInputSchema,
  type DocPublishOutput,
  DocPublishOutputSchema,
} from "@editorzero/schemas/doc/publish";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_PUBLISH_ID = CapabilityId("doc.publish");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocPublishInputSchema` / `DocPublishOutputSchema` are the single source
// (ADR 0034), reused verbatim by the API route's `validator` / `resolver`
// so the wire contract has exactly one definition. The input is the same
// single-`doc_id` shape as `doc.get` (validated UUIDv7, branded via
// `.transform`); the output returns the post-update projection — with
// `visibility` pinned to the literal `"public"` (not the wider enum)
// because the capability's entire purpose is to land on that state — so
// callers don't need a follow-up `doc.get`. Definitions + rationale live
// at `@editorzero/schemas/doc/publish`.

// ── Capability ───────────────────────────────────────────────────────────

export const docPublish: Capability<DocPublishInput, DocPublishOutput> = {
  id: DOC_PUBLISH_ID,
  category: "mutation",
  summary: "Set a doc's visibility to public.",
  input: DocPublishInputSchema,
  output: DocPublishOutputSchema,
  requires: ["doc:publish"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.publish",
      doc_id: output.doc_id,
      published_at: output.published_at,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_PUBLISH_ID,
      required_scopes: ["doc:publish"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_PUBLISH_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Single UPDATE with expression-builder increment
    // (`kysely@0.28.16` supports `eb('col', '+', 1)` at
    // `expression-builder.d.ts:64-72`). The WHERE filters soft-deleted
    // docs so a trashed row returns zero rows from `.returning(...)`
    // and the handler throws 404 without writing. The
    // `WorkspaceScopingPlugin` appends `workspace_id = ctx.tenant.*`
    // on both the UPDATE and the RETURNING clause (F87 alias-aware),
    // so a cross-workspace target is invisible — same 404 projection.
    // Single-statement + `RETURNING` keeps the "0 rows = not found"
    // branch atomic with the write, so the idempotent bump semantic
    // can't race against a concurrent soft-delete between a split
    // SELECT and UPDATE.
    const row = await ctx.db
      .updateTable("docs")
      .set((eb) => ({
        visibility: "public",
        visibility_version: eb("visibility_version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .returning(["id", "visibility_version"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // `doc.visibility_changed` — downstream cache/public-route
    // invalidator (§5.4, F5). Keyed on `visibility_version` so a
    // forwarder seeing an out-of-order row can reject the stale
    // one without coordination. Committed inside the same write-
    // path tx as the UPDATE above via the dispatcher's `ctx.outbox`
    // queue → `createOutboxWriter` flush (architecture.md §2101,
    // ADR 0018 F10/F31).
    ctx.outbox("doc.visibility_changed", {
      doc_id: row.id,
      visibility: "public",
      visibility_version: row.visibility_version,
    });

    return {
      doc_id: row.id,
      visibility: "public",
      visibility_version: row.visibility_version,
      published_at: now,
    };
  },
};
