/**
 * `GET /audits/get/:audit_id` — audit.get surface (invariant 4).
 *
 * Fetches a single audit-event row. `:audit_id` is a UUIDv7; the
 * capability refuses anything else at zod parse (regex-narrow before
 * lookup). Mirrors the `docs.get/:doc_id` path-param shape and the
 * `<domain>_id` convention the CLI-binding derivation expects
 * (`apps/cli/src/generator/http-binding.ts`).
 *
 * **Scope.** `workspace:admin`. Row shape identical to an element
 * of `audit.list`'s response.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const AUDIT_GET_ID = CapabilityId("audit.get");

const AuditGetParams = z
  .object({
    audit_id: z.string().openapi({ description: "UUIDv7 of the audit event." }),
  })
  .openapi("AuditGetParams");

const AuditGetResponse = z
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
  .openapi("AuditGetResponse");

const getRouteDef = createRoute({
  method: "get",
  path: "/audits/get/:audit_id",
  tags: ["audit"],
  summary: "Fetch a single audit event by id; admin-only.",
  request: {
    params: AuditGetParams,
  },
  responses: {
    200: {
      description: "The audit event row.",
      content: { "application/json": { schema: AuditGetResponse } },
    },
    400: {
      description: "Validation error — audit_id is not a UUIDv7.",
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
    404: {
      description: "No audit event with the given id in the caller's workspace.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
  },
});

export const get = defineOpenAPIRoute<typeof getRouteDef, ApiEnv, true>({
  route: getRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const { audit_id } = c.req.valid("param");
    const result = await dispatcher.dispatch({
      capability_id: AUDIT_GET_ID,
      input: { audit_id },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof AuditGetResponse>, 200);
  },
  addRoute: true,
});
