/**
 * `audit.list` — paginated workspace-scoped read of `audit_events`
 * (architecture.md §3.11; invariant 3: audit log reconstructs final
 * state, so inspection needs a first-class capability).
 *
 * **Scope — `workspace:admin`.** Audit rows reveal cross-principal
 * activity (who mutated what, who was denied for which reason). Any-
 * member read would leak colleague behaviour to every peer. Admin-
 * only keeps it enterprise-shaped. A future `audit.list_self` /
 * `audit:read_self` scope could widen visibility to "my own rows
 * only" without relaxing this capability's envelope.
 *
 * **Pagination — composite cursor.** `(created_at, id)` sort with
 * both-or-neither refine on `(before_created_at, before_id)`.
 * Rationale: `audit_events.created_at` is epoch-ms; collisions are
 * inevitable under bursty writes, so a plain timestamp cursor drops
 * or duplicates rows at page boundaries. The composite predicate
 * `(created_at < ?) OR (created_at = ? AND id < ?)` paired with a
 * UUIDv7 tiebreak is collision-safe. Cursor fields are surfaced
 * explicitly on the wire (not opaque-blob-encoded) so CLI callers
 * can read the next-page args at a glance — `ez audits list
 * --before-created-at=<n> --before-id=<id>` — without base64
 * opacity. On the final page the response carries `next_cursor:
 * null`.
 *
 * **Filters — slice 1.** `subject_kind`, `subject_id`,
 * `capability_id`, `outcome`, `since`, `until`. `subject_id` refines
 * to require its `subject_kind` partner (the (subject_kind,
 * subject_id, created_at) index on `audit_events` only narrows
 * correctly when both are set, and a bare id across heterogeneous
 * subject brands is semantically sloppy). `principal_*` filters are
 * deliberately deferred — admin-scope callers can already pivot via
 * `capability_id` or subject; a principal-centric investigation
 * surface gets its own capability when the use case lands.
 *
 * **Audit — declares the standard read-collapse policy.** The
 * capability advertises `collapsible: true` with `window_ms =
 * AUDIT_READ_COLLAPSE_WINDOW_MS` and a constant bucket key. Backend
 * collapse is deferred at the writer layer (`packages/db/src/audit-
 * writer.ts` — `collapsed_count` is always 1 today); until the
 * dispatcher threads `collapsePolicy` through `AuditWriteInput` and
 * the writer performs a keyed UPDATE-or-INSERT, repeated
 * `audit.list` calls still emit one row per call. The policy here
 * is the shape the writer will honour when that slice lands.
 *
 * **Effect shape at the wire.** Each row's `effect` column is stored
 * as TEXT-JSON of a discriminated `AuditEffect | AuditDeny |
 * AuditError`. Expressing the full union at the audit-surface
 * boundary would mirror the entire capability-effect registry in
 * zod and require a widening every time a new capability lands —
 * exactly the drift risk Codex flagged. Instead the response types
 * `effect` as `{ kind: string } & unknown-passthrough` and the row's
 * top-level `outcome` enum (`allow|deny|error`) is the strict
 * discriminator. Consumers that need specific effect fields
 * narrow at read time against the shared `@editorzero/audit`
 * types.
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { CapabilityId } from "@editorzero/ids";
import {
  type AuditListInput,
  AuditListInputSchema,
  type AuditListOutput,
  AuditListOutputSchema,
} from "@editorzero/schemas/audit/list";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const AUDIT_LIST_ID = CapabilityId("audit.list");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `AuditListInputSchema` / `AuditListOutputSchema` are the single source
// (ADR 0034), reused verbatim by the API route's `validator` / `resolver`.
// The input's three refines (cursor both-or-neither, `subject_id` requires
// `subject_kind`, `since <= until`), the numeric-field `z.coerce.number()`
// query-string handling, and the shared `AuditRowSchema` reuse for the
// response are documented at the schema definition in
// `@editorzero/schemas/audit/list`.

// ── Capability ───────────────────────────────────────────────────────────

export const auditList: Capability<AuditListInput, AuditListOutput> = {
  id: AUDIT_LIST_ID,
  category: "read",
  summary: "List audit events in the workspace; paginated, admin-only.",
  input: AuditListInputSchema,
  output: AuditListOutputSchema,
  requires: ["workspace:admin"],
  // "ui" landed with the /audit trail screen (the audit.list × Web UI
  // cell — the app's first cursor-paginated screen) — proven end-to-end
  // by the marked Playwright spec in packages/e2e
  // (proves-capability-cell: audit.list).
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: () => ({ kind: "workspace" }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: AUDIT_LIST_ID,
      required_scopes: ["workspace:admin"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(AUDIT_LIST_ID, error),
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      // Constant bucket; the dispatcher's input_hash-based dedup
      // separates distinct filter combinations within the window
      // without per-filter `collapseKey` arithmetic.
      collapseKey: () => "audit.list",
    },
  },
  handler: async (ctx, input) => {
    // Peek one extra row to know if a next page exists without a
    // follow-up COUNT query. `events.length === limit + 1` means
    // trim the extra, emit `next_cursor` from the last kept row;
    // `events.length <= limit` means we've reached the end,
    // `next_cursor = null`.
    const peekLimit = input.limit + 1;

    let qb = ctx.db
      .selectFrom("audit_events")
      .select([
        "id",
        "workspace_id",
        "capability_id",
        "category",
        "principal_kind",
        "principal_id",
        "acting_as_user_id",
        "session_id",
        "token_id",
        "subject_kind",
        "subject_id",
        "outcome",
        "deny_reason",
        "input_hash",
        "effect",
        "duration_ms",
        "trace_id",
        "created_at",
        "collapsed_count",
      ])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(peekLimit);

    if (input.before_created_at !== undefined && input.before_id !== undefined) {
      // Composite-cursor predicate: strictly-lesser `created_at`, OR
      // equal `created_at` with strictly-lesser `id`. UUIDv7's
      // monotonic prefix keeps id tiebreak consistent with creation
      // order.
      const { before_created_at, before_id } = input;
      qb = qb.where((eb) =>
        eb.or([
          eb("created_at", "<", before_created_at),
          eb.and([eb("created_at", "=", before_created_at), eb("id", "<", before_id)]),
        ]),
      );
    }

    if (input.subject_kind !== undefined) {
      qb = qb.where("subject_kind", "=", input.subject_kind);
    }
    if (input.subject_id !== undefined) {
      qb = qb.where("subject_id", "=", input.subject_id);
    }
    if (input.capability_id !== undefined) {
      qb = qb.where("capability_id", "=", input.capability_id);
    }
    if (input.outcome !== undefined) {
      qb = qb.where("outcome", "=", input.outcome);
    }
    if (input.since !== undefined) {
      qb = qb.where("created_at", ">=", input.since);
    }
    if (input.until !== undefined) {
      qb = qb.where("created_at", "<=", input.until);
    }

    const rows = await qb.execute();

    const hasMore = rows.length > input.limit;
    const kept = hasMore ? rows.slice(0, input.limit) : rows;

    const events = kept.map((row) => ({
      ...row,
      // `effect` is stored as TEXT JSON; deserialize at the boundary.
      // The dispatcher-side writer is the only producer of this
      // column, so the parse is trusted — a malformed row would be a
      // server-internal inconsistency, not a user input path.
      effect: JSON.parse(row.effect) as { kind: string } & Record<string, unknown>,
    }));

    const lastKept = kept[kept.length - 1];
    const next_cursor =
      hasMore && lastKept !== undefined
        ? { before_created_at: lastKept.created_at, before_id: lastKept.id }
        : null;

    return { events, next_cursor };
  },
};
