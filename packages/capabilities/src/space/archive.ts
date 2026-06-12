/**
 * `space.archive` — soft-delete a space with live-descendants refusal
 * (ADR 0040 invariant-6 bullet; ADR 0017 posture; Appendix A row).
 * Metadata-only mutation; `space:manage` scope.
 *
 * **Why refuse, not cascade.** Identical reasoning to
 * `collection.delete`: ADR 0017 anchors soft-delete on a 1:1
 * recoverable inverse, and a cascade would force a cascading restore
 * (N audit rows, a tree-walk inverse). The caller empties the space —
 * collections out (`collection.delete`/`collection.move`), members out
 * (`space.member_remove`) — then archives. The refusal payload
 * (`SpaceHasLiveDescendantsError`) carries the three counts so a
 * client renders "2 collections + 5 docs + 3 members still here"
 * without a follow-up list call.
 *
 * **What survives the archive.** Grant rows on the space (and on docs
 * formerly reachable through it) deliberately RIDE through (H1:
 * grants carry no deleted_at; state-as-of-delete) — `space.restore`
 * revives the exact ACL 1:1. They confer nothing while the space is
 * trashed: the ceiling resolver fails closed on dead rows everywhere
 * except the intent-named `canRestoreSpace`.
 *
 * **Descendants scope.** Live collections bound to the space (the
 * direct children), live docs reachable through those collections
 * (informational — a live doc structurally requires a live collection,
 * so the collections count alone already blocks; the docs count makes
 * the error actionable), and `space_members` rows (hard-delete table —
 * any row counts). TRASHED collections bound to the space do NOT block
 * (they are already in the trash and keep their binding for restore).
 *
 * **Personal spaces are archivable by their owner** (the ladder gives
 * exactly the owner; admins stay excluded — the privacy pin). Nothing
 * re-seeds a personal space after archive (signup runs once), so the
 * owner's drafts home stays recoverable via `space.restore` only.
 *
 * **Already-deleted / missing → 404** (trash-invisible, the
 * `space.update` posture; re-archiving would slide the recovery
 * window).
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError, SpaceHasLiveDescendantsError } from "@editorzero/errors";
import { CapabilityId, SpaceId } from "@editorzero/ids";
import {
  type SpaceArchiveInput,
  SpaceArchiveInputSchema,
  type SpaceArchiveOutput,
  SpaceArchiveOutputSchema,
} from "@editorzero/schemas/space/archive";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_ARCHIVE_ID = CapabilityId("space.archive");

export const spaceArchive: Capability<SpaceArchiveInput, SpaceArchiveOutput> = {
  id: SPACE_ARCHIVE_ID,
  category: "mutation",
  summary:
    "Soft-delete (archive) a space; refuses while live collections, docs, or members remain. Reversible via space.restore.",
  input: SpaceArchiveInputSchema,
  output: SpaceArchiveOutputSchema,
  requires: ["space:manage"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "space", id: input.space_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "space.archive",
      space_id: output.space_id,
      deleted_at: output.deleted_at,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: SPACE_ARCHIVE_ID,
      required_scopes: ["space:manage"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(SPACE_ARCHIVE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const space_id = SpaceId(input.space_id);

    // Step 1 — existence + trash posture (404 FIRST, before authority).
    const space = await ctx.db
      .selectFrom("spaces")
      .select(["id"])
      .where("id", "=", space_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (space === undefined) {
      throw new NotFoundError({ subject_kind: "space", subject_id: input.space_id });
    }

    // Step 2 — authority (the live ladder).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanAdministerSpace(space_id);

    // Step 3 — live-descendants refusal. Three counts in parallel
    // (independent tables); the docs count joins through LIVE
    // collections only — the tenant wrapper scopes both join
    // participants.
    const [liveCollections, liveDocs, members] = await Promise.all([
      ctx.db
        .selectFrom("collections")
        .where("space_id", "=", space_id)
        .where("deleted_at", "is", null)
        .select((eb) => eb.fn.countAll<string | number | bigint>().as("count"))
        .executeTakeFirstOrThrow(),
      ctx.db
        .selectFrom("docs")
        .innerJoin("collections", "collections.id", "docs.collection_id")
        .where("collections.space_id", "=", space_id)
        .where("collections.deleted_at", "is", null)
        .where("docs.deleted_at", "is", null)
        .select((eb) => eb.fn.countAll<string | number | bigint>().as("count"))
        .executeTakeFirstOrThrow(),
      ctx.db
        .selectFrom("space_members")
        .where("space_id", "=", space_id)
        .select((eb) => eb.fn.countAll<string | number | bigint>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);

    const counts = {
      collections: Number(liveCollections.count),
      docs: Number(liveDocs.count),
      members: Number(members.count),
    };
    if (counts.collections > 0 || counts.docs > 0 || counts.members > 0) {
      throw new SpaceHasLiveDescendantsError({
        space_id,
        descendant_counts: counts,
      });
    }

    // Step 4 — soft-delete. The liveness guard defends against a
    // concurrent archive between step 1 and here; zero rows → 404
    // (honest projection, the collection.delete posture).
    const row = await ctx.db
      .updateTable("spaces")
      .set({ deleted_at: now, updated_at: now })
      .where("id", "=", space_id)
      .where("deleted_at", "is", null)
      .returning(["id"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "space", subject_id: input.space_id });
    }

    return SpaceArchiveOutputSchema.parse({ space_id: row.id, deleted_at: now });
  },
};
