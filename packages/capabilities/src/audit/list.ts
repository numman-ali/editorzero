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
 * **Audit — read-collapsible, workspace-scoped bucket.** Identical
 * `audit.list` calls within `AUDIT_READ_COLLAPSE_WINDOW_MS` fold to
 * one row (ADR 0009 §9.3). The collapse key is constant; the
 * dispatcher's input-hash dedup separates distinct filter calls
 * within a bucket without per-filter `collapseKey` arithmetic.
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
import { CapabilityId, WorkspaceId } from "@editorzero/ids";
import { SUBJECT_KINDS } from "@editorzero/scopes";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const AUDIT_LIST_ID = CapabilityId("audit.list");

// ── Input ────────────────────────────────────────────────────────────────
//
// Three refines layered on the strict object:
//   1. cursor pair is both-or-neither (`before_created_at` without
//      `before_id` is a page boundary with no tiebreak, which defeats
//      the whole point of the composite cursor);
//   2. `subject_id` requires `subject_kind` (the (subject_kind,
//      subject_id, created_at) index only narrows correctly when both
//      are set);
//   3. `since <= until` when both are present (a backwards time
//      range always returns zero rows — catch at the boundary to
//      distinguish operator intent from a typo).
//
// `limit` defaults to 50; max is 200 to cap a single response's row
// count. Callers that need larger scans paginate.

const InputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    before_created_at: z.number().int().optional(),
    before_id: z.string().optional(),
    subject_kind: z.enum(SUBJECT_KINDS).optional(),
    subject_id: z.string().optional(),
    capability_id: z.string().optional(),
    outcome: z.enum(["allow", "deny", "error"]).optional(),
    since: z.number().int().optional(),
    until: z.number().int().optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.before_created_at === undefined && v.before_id === undefined) ||
      (v.before_created_at !== undefined && v.before_id !== undefined),
    { message: "before_created_at and before_id must be provided together" },
  )
  .refine((v) => v.subject_id === undefined || v.subject_kind !== undefined, {
    message: "subject_id requires subject_kind",
  })
  .refine((v) => v.since === undefined || v.until === undefined || v.since <= v.until, {
    message: "since must be less than or equal to until",
  });
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────

const WorkspaceIdField = z.string().transform((s): WorkspaceId => WorkspaceId(s));

const EffectSchema = z.object({ kind: z.string() }).catchall(z.unknown());

const AuditRowSchema = z.object({
  id: z.string(),
  workspace_id: WorkspaceIdField,
  capability_id: z.string(),
  category: z.enum(["mutation", "read", "auth", "admin", "system"]),
  principal_kind: z.enum(["user", "agent"]),
  principal_id: z.string(),
  acting_as_user_id: z.string().nullable(),
  session_id: z.string().nullable(),
  token_id: z.string().nullable(),
  subject_kind: z.string(),
  subject_id: z.string().nullable(),
  outcome: z.enum(["allow", "deny", "error"]),
  deny_reason: z.string().nullable(),
  input_hash: z.string(),
  effect: EffectSchema,
  duration_ms: z.number(),
  trace_id: z.string().nullable(),
  created_at: z.number(),
  collapsed_count: z.number(),
});

const CursorSchema = z.object({
  before_created_at: z.number(),
  before_id: z.string(),
});

const OutputSchema = z.object({
  events: z.array(AuditRowSchema),
  next_cursor: CursorSchema.nullable(),
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const auditList: Capability<Input, Output> = {
  id: AUDIT_LIST_ID,
  category: "read",
  summary: "List audit events in the workspace; paginated, admin-only.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["workspace:admin"],
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
