/**
 * `GET /audits/list` — audit.list surface (invariant 4).
 *
 * First capability route with a query-string schema. Filters +
 * pagination cursor live on the URL; the capability handler sees a
 * fully-typed input (numbers, enums) via `z.coerce.*` at the route
 * layer. On-the-wire URL encoding stays canonical: callers send
 * `?limit=50&since=1700000000&subject_kind=doc&subject_id=<uuid>`;
 * the route schema coerces to the shape the capability expects.
 *
 * **Cursor shape.** `before_created_at` + `before_id` are surfaced
 * as two explicit query keys rather than an opaque blob — the
 * CLI renders the next-page args at a glance (`ez audits list
 * --before-created-at=<n> --before-id=<uuid>`). The three semantic
 * refines (cursor pair both-or-neither, subject pair both-or-
 * neither, `since <= until`) are mirrored at the route layer so
 * the OpenAPI / generated-client contract matches runtime —
 * without the mirror, callers would see these as independently-
 * optional fields while the capability would throw 400 at zod
 * parse. Same class of drift Codex flagged on `doc.update`.
 *
 * **Scope.** `workspace:admin` — the capability refuses other
 * callers at the dispatcher gate. The route declares 403 so the
 * OpenAPI doc carries the contract.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { SUBJECT_KINDS } from "@editorzero/scopes";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const AUDIT_LIST_ID = CapabilityId("audit.list");

const AuditListQuery = z
  .object({
    // All query-string values arrive as strings; `z.coerce.*` parses
    // at the route boundary so the dispatcher's zod parse sees the
    // numeric/enum shape the capability declares.
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before_created_at: z.coerce.number().int().optional(),
    before_id: z.string().optional(),
    subject_kind: z.enum(SUBJECT_KINDS).optional(),
    subject_id: z.string().optional(),
    capability_id: z.string().optional(),
    outcome: z.enum(["allow", "deny", "error"]).optional(),
    since: z.coerce.number().int().optional(),
    until: z.coerce.number().int().optional(),
  })
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
  })
  .openapi("AuditListQuery");

const AuditRow = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
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
    effect: z.object({ kind: z.string() }).catchall(z.unknown()),
    duration_ms: z.number(),
    trace_id: z.string().nullable(),
    created_at: z.number(),
    collapsed_count: z.number(),
  })
  .openapi("AuditRow");

const AuditCursor = z
  .object({
    before_created_at: z.number(),
    before_id: z.string(),
  })
  .openapi("AuditCursor");

const AuditListResponse = z
  .object({
    events: z.array(AuditRow),
    next_cursor: AuditCursor.nullable(),
  })
  .openapi("AuditListResponse");

const listRouteDef = createRoute({
  method: "get",
  path: "/audits/list",
  tags: ["audit"],
  summary: "List audit events in the caller's workspace; paginated, admin-only.",
  request: {
    query: AuditListQuery,
  },
  responses: {
    200: {
      description: "Page of audit events with an optional next-page cursor.",
      content: { "application/json": { schema: AuditListResponse } },
    },
    400: {
      description:
        "Validation error — invalid cursor pair, mismatched subject filter, or backwards time range.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("validation") }),
        },
      },
    },
    401: {
      description: "Unauthenticated.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("unauthenticated") }),
        },
      },
    },
    403: {
      description: "Permission denied — caller lacks `workspace:admin`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
  },
});

export const list = defineOpenAPIRoute<typeof listRouteDef, ApiEnv, true>({
  route: listRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const query = c.req.valid("query");
    const result = await dispatcher.dispatch({
      capability_id: AUDIT_LIST_ID,
      input: query,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof AuditListResponse>, 200);
  },
  addRoute: true,
});
