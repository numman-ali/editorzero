/**
 * `GET /audits/list` — list audit events in the caller's workspace
 * (invariant 4); paginated, admin-only.
 *
 * **Code-first route shape (ADR 0029); mirrors the `docs/create` golden.**
 * A self-contained `Hono<ApiEnv>` sub-app built from three chained
 * handlers via `factory.createHandlers(...)`:
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (summary, tags,
 *      per-status response schemas). Documents the contract; does not
 *      feed `hc`.
 *   2. `validator("query", AuditListInputSchema, hook)` — Standard-Schema
 *      request validation. This is the first query-string route: filters
 *      and the pagination cursor live on the URL as strings, and the
 *      shared input schema's `z.coerce.*` fields parse them at the route
 *      boundary so the handler (and dispatcher) see the numeric/enum shape
 *      the capability declares. The hook projects any parse failure — a
 *      malformed cursor pair, a `subject_id` without `subject_kind`, a
 *      backwards `since`/`until` range, or an unknown filter key (the
 *      schema is `.strict()`) — to the `{ error: "validation_failed" }`
 *      envelope at 400 (a cross-cutting middleware return, intentionally
 *      not an `hc` arm — see `lib/errors.ts`).
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches `audit.list`, and returns the dispatcher's output
 *      through `c.json`. The dispatcher *throws* `EditorZeroError`
 *      subclasses; the handler catches and maps them with
 *      `errorResponse(c, err)` (e.g. the `workspace:admin` gate's
 *      `PermissionDeniedError` → 403) to explicit, literal-typed `c.json`
 *      returns — those explicit returns are what `hc<AppType>` reads to
 *      infer the error arm (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` — the
 * `user | agent` union; the handler only reads `workspace_id` (present on
 * both arms) and forwards `principal` to the dispatcher. `dispatch`
 * returns `Promise<unknown>`; rather than *assert* a type, the handler
 * *parses* that `unknown` through `AuditListOutputSchema.parse` — the
 * honest `unknown`→typed narrowing, and a runtime guard that the
 * dispatcher output still satisfies the published contract (a drift
 * surfaces as a ZodError → 500, not a silent lie).
 *
 * The route mounts at a path **relative** to its domain (`/list`); the
 * `audit` domain mounts at `/audits` on the trunk, so the external path
 * is `/audits/list`. `hc<AppType>` reconstructs `client.audits.list.$get`.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `AuditListInputSchema` / `AuditListOutputSchema` from
 * `@editorzero/schemas/audit/list` are the single source the capability
 * also consumes — including the three semantic refines (cursor-pair
 * both-or-neither, subject-pair both-or-neither, `since <= until`) and the
 * `.strict()` boundary. There is no wire copy to drift from the capability
 * because there is no copy: the cursor's `before_created_at`/`before_id`
 * are surfaced as two explicit query keys (the CLI renders the next-page
 * args at a glance), and `resolver`/`describeRoute` generate the OpenAPI
 * from the schema directly, so the spec matches runtime.
 *
 * **Audit + permission live inside the dispatcher.** The handler only
 * dispatches; the `workspace:admin` permission gate is the dispatcher's
 * (the route declares 403 so the OpenAPI doc carries the contract).
 */

import { CapabilityId } from "@editorzero/ids";
import { AuditListInputSchema, AuditListOutputSchema } from "@editorzero/schemas/audit/list";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AUDIT_LIST_ID = CapabilityId("audit.list");

export const list = new Hono<ApiEnv>().get(
  "/list",
  ...factory.createHandlers(
    describeRoute({
      tags: ["audit"],
      summary: "List audit events in the caller's workspace; paginated, admin-only.",
      responses: {
        200: {
          description: "Page of audit events with an optional next-page cursor.",
          content: jsonContent(AuditListOutputSchema),
        },
        400: {
          description:
            "Validation error — invalid cursor pair, mismatched subject filter, backwards time range, or unknown filter key.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `workspace:admin`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
      },
    }),
    validator("query", AuditListInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("query");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AUDIT_LIST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AuditListOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
