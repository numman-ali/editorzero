/**
 * `GET /audits/get/:audit_id` — fetch a single audit-event row (audit.get
 * surface; invariant 4). Admin-only (`workspace:admin`); the row shape is
 * identical to an element of `audit.list`'s response.
 *
 * **Code-first shape (ADR 0029).** Like the `docs/create` golden, this is
 * a self-contained `Hono<ApiEnv>` sub-app built from chained handlers via
 * `factory.createHandlers(...)`:
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (per-status
 *      response schemas). Documents the contract; does not feed `hc`.
 *   2. `validator("param", AuditGetInputSchema, hook)` — Standard-Schema
 *      validation of the path param. The capability's input *is* the
 *      single-id object (`{ audit_id }`), so the shared input schema is
 *      reused verbatim as the param validator (PATTERN P2 — no separate
 *      param schema). The hook projects a parse failure to the
 *      `{ error: "validation_failed" }` envelope at 400 (a cross-cutting
 *      middleware return, intentionally not an `hc` arm — see `lib/errors.ts`).
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches `audit.get`, and returns the dispatcher's output through
 *      `c.json`. The dispatcher *throws* `EditorZeroError` subclasses; the
 *      handler catches and maps them with `errorResponse(c, err)` to
 *      explicit, literal-typed `c.json` returns — those explicit returns
 *      are what `hc<AppType>` reads to infer the error arm (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` — the
 * `user | agent` union; the handler only reads `workspace_id` (present on
 * both arms) and forwards `principal` to the dispatcher. `dispatch`
 * returns `Promise<unknown>`; rather than *assert* a type with `as`, the
 * handler *parses* that `unknown` through the capability's shared response
 * schema (`AuditGetOutputSchema.parse`) — the honest `unknown`→typed
 * narrowing, and a runtime guard that the dispatcher output still
 * satisfies the published contract.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `AuditGetInputSchema` / `AuditGetOutputSchema` from
 * `@editorzero/schemas/audit/get` are the single source the capability
 * also consumes (the output side is the shared `AuditRowSchema`, so
 * `audit.get` and `audit.list` cannot drift on the row shape). No wire
 * copy is re-declared here — the whole point of this migration.
 *
 * The route mounts at a path **relative** to its domain (`/get/:audit_id`);
 * the `audits` domain mounts at `/audits` on the trunk, so the external
 * path is `/audits/get/:audit_id`.
 *
 * **Audit + permission live inside the dispatcher.** The handler only
 * dispatches; the `workspace:admin` permission gate and the audit entry
 * are the dispatcher's.
 */

import { CapabilityId } from "@editorzero/ids";
import { AuditGetInputSchema, AuditGetOutputSchema } from "@editorzero/schemas/audit/get";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const AUDIT_GET_ID = CapabilityId("audit.get");

export const get = new Hono<ApiEnv>().get(
  "/get/:audit_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["audit"],
      summary: "Fetch a single audit event by id; admin-only.",
      responses: {
        200: {
          description: "The audit event row.",
          content: jsonContent(AuditGetOutputSchema),
        },
        400: {
          description: "Validation error — audit_id is not a UUIDv7.",
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
        404: {
          description: "No audit event with the given id in the caller's workspace.",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", AuditGetInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("param");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: AUDIT_GET_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(AuditGetOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
