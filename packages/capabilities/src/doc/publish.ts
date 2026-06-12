/**
 * `doc.publish` — set a doc's publish dimension: mint `published_slug`,
 * stamp `published_at` (architecture.md §3.5; ADR 0040 Step 5;
 * `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`).
 *
 * Publish is ORTHOGONAL to `access_mode` (the Step-5 de-overload): a
 * `private` doc can be published, a `space` doc can be unpublished.
 * "Published" means `published_at IS NOT NULL`; this capability never
 * touches `access_mode`.
 *
 * Metadata-only mutation: no `ctx.transact`, no Y.Doc touching, no
 * `doc_updates` row. Idempotent at the state level: re-publishing an
 * already-published doc keeps BOTH `published_slug` (URL stability — a
 * live public link must never rotate out from under its readers) and
 * the original `published_at` (the "first published" timestamp is a
 * fact, not a counter). `render_version` bumps on every successful
 * invocation regardless (F5 — the version is a stable signal that
 * *something* happened, not a change-detector).
 *
 * **Slug minting.** `published_slug` defaults to the doc's internal
 * `slug`; collisions against the live published set resolve by suffix
 * (`-2`, `-3`, … — architecture §3.5). The internal slug is per-
 * collection-unique while the published slug is WORKSPACE-unique
 * (`docs_published_slug_unique`, soft-deleted rows excluded), so two
 * docs named "getting-started" in different collections can both exist
 * but only the first to publish gets the bare URL. The mint runs as a
 * SELECT inside the dispatcher's write-path tx: SQLite's single-writer
 * serializes concurrent publishes outright; on Postgres (READ
 * COMMITTED) a same-candidate race is backstopped by the partial
 * unique index — the loser surfaces through the dispatcher's error
 * projection rather than double-allocating a URL.
 *
 * **Scope.** `doc:publish`. Distinct from `doc:write` so platform members
 * (who hold `doc:write` for authoring) can't trivially expose a doc
 * publicly — that requires a deliberate role grant. Matches the matrix's
 * split at the `editor` agent tier (`AGENT_SCOPE_TIERS`).
 *
 * **Soft-deleted handling.** A `deleted_at IS NOT NULL` doc returns 404,
 * same as `doc.get` — publishing a trashed doc has no defined meaning.
 * (`doc.soft_delete` clears the publish dimension; restore does NOT
 * re-publish — see `delete.ts`.)
 *
 * **Audit effect.** `{ kind: "doc.publish", doc_id, published_slug,
 * published_at }`. The slug is handler-COMPUTED, so the effect must
 * carry it — replay can never re-derive a collision-suffixed value
 * (the same effect-carries-the-handler-computed-value contract as
 * `doc.rename`'s slug).
 *
 * **Render consumer still deferred.** The public `(public)/[domain]/
 * [slug]` route and the outbox→render consumer need substrate that does
 * not exist yet (§12 jobs runner, the §7 markdown projection, an
 * anonymous principal). This slice lands the full publish DATA model;
 * the `doc.publish_changed` outbox event (keyed on `render_version`) is
 * the seam the renderer subscribes to when it ships.
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

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_PUBLISH_ID = CapabilityId("doc.publish");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocPublishInputSchema` / `DocPublishOutputSchema` are the single source
// (ADR 0034), reused verbatim by the API route's `validator` / `resolver`
// so the wire contract has exactly one definition. The output pins the
// published post-state structurally (`published_slug`/`published_at`
// non-nullable) so callers don't need a follow-up `doc.get`. Definitions
// + rationale live at `@editorzero/schemas/doc/publish`.

// ── Capability ───────────────────────────────────────────────────────────

export const docPublish: Capability<DocPublishInput, DocPublishOutput> = {
  id: DOC_PUBLISH_ID,
  category: "mutation",
  summary: "Publish a doc — mint its public URL slug and stamp published_at.",
  input: DocPublishInputSchema,
  output: DocPublishOutputSchema,
  requires: ["doc:publish"],
  agentAllowed: {},
  // "ui" is declared because the Web UI actually binds this capability
  // (the doc header's Publish toggle; proven by the marked Playwright spec
  // in packages/e2e). Declared surfaces = bound surfaces (ADR 0040 H11) —
  // packages/contract-tests fails the build if "ui" appears here without
  // a proving spec, or vice versa.
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.publish",
      doc_id: output.doc_id,
      published_slug: output.published_slug,
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

    // Read first: the mint needs the doc's internal slug, and the
    // idempotent re-publish branch needs the existing publish pair. The
    // `WorkspaceScopingPlugin` scopes both this read and the UPDATE
    // below, so a cross-workspace target is invisible (404 projection).
    const doc = await ctx.db
      .selectFrom("docs")
      .select([
        "id",
        "slug",
        "published_slug",
        "published_at",
        "created_by",
        "access_mode",
        "collection_id",
      ])
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (doc === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // Ceiling assert (ADR 0040 Step 6): publishing is gated on READ
    // reach — you cannot expose a doc you cannot read. Runs inside the
    // metadata-only tx (ctx.db IS the tx handle here); the deny throw
    // aborts the tx, so nothing escapes. The privacy invariant's other
    // half (a private-Space doc needs an explicit publish to go
    // public) is exactly this capability being the only door.
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanRead(doc);

    let published_slug: string;
    let published_at: number;
    if (doc.published_slug !== null && doc.published_at !== null) {
      // Already published — idempotent re-assert. URL and original
      // publish time stay stable; only `render_version` moves.
      published_slug = doc.published_slug;
      published_at = doc.published_at;
    } else {
      // Mint against the LIVE published set (`deleted_at IS NULL`
      // mirrors the partial unique index — a trashed doc's old URL is
      // reusable by design). One SELECT pulls the base and every
      // suffixed sibling; the smallest free candidate wins.
      const taken = new Set(
        (
          await ctx.db
            .selectFrom("docs")
            .select("published_slug")
            .where("published_slug", "is not", null)
            .where("deleted_at", "is", null)
            .where((eb) =>
              eb.or([
                eb("published_slug", "=", doc.slug),
                eb("published_slug", "like", `${doc.slug}-%`),
              ]),
            )
            .execute()
        ).map((r) => r.published_slug),
      );
      if (taken.has(doc.slug)) {
        let n = 2;
        while (taken.has(`${doc.slug}-${n}`)) n += 1;
        published_slug = `${doc.slug}-${n}`;
      } else {
        published_slug = doc.slug;
      }
      published_at = now;
    }

    // The `deleted_at IS NULL` guard re-applies so a concurrent
    // soft-delete between the read and this write lands as 404, never
    // as a publish of a trashed doc.
    const row = await ctx.db
      .updateTable("docs")
      .set((eb) => ({
        published_slug,
        published_at,
        render_version: eb("render_version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .returning(["id", "render_version"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // `doc.publish_changed` — the future renderer's invalidation signal
    // (renamed from `doc.visibility_changed` at the Step-5 split). Keyed
    // on `render_version` so a forwarder seeing an out-of-order row can
    // reject the stale one without coordination. Committed inside the
    // same write-path tx as the UPDATE via the dispatcher's `ctx.outbox`
    // queue → `createOutboxWriter` flush (F10/F31).
    ctx.outbox("doc.publish_changed", {
      doc_id: row.id,
      published_slug,
      published_at,
      render_version: row.render_version,
    });

    return {
      doc_id: row.id,
      published_slug,
      published_at,
      render_version: row.render_version,
    };
  },
};
