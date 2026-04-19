/**
 * `GET /docs/list` — first capability route (ADR 0021 / invariant 4).
 *
 * The minimal shape every capability route shares:
 *
 *   1. zod input + output schemas declared on the route (OpenAPI doc
 *      generation + `hc<AppType>` RPC typing both derive from these).
 *   2. Handler reads `c.var.principal` + `c.var.dispatcher` and
 *      dispatches the capability. The principal + dispatcher are
 *      attached to `c.var` by the trunk's `/docs/*`-scoped middleware
 *      chain (`createApiApp` wires `createPrincipalMiddleware` +
 *      `createDispatcherMiddleware` for this prefix).
 *   3. Capability output is returned as-is through `c.json`. The
 *      capability's zod output schema has already validated the shape
 *      inside the dispatcher, so no further coercion is needed here.
 *
 * **Why the response schema duplicates the capability output shape.**
 * The capability's `OutputSchema` uses `z.string().transform((s):
 * DocId => DocId(s))` for branded IDs. On the wire, branded strings
 * serialize as plain strings — the OpenAPI contract should say
 * `string`, not "string with a brand". A local response schema makes
 * the API contract explicit + avoids coupling the public OpenAPI
 * surface to the capability's internal transform semantics. Registry-
 * driven codegen (future) will emit both the capability schemas and
 * the route schemas from a single source; that seam replaces this
 * duplication.
 *
 * **Middleware is NOT declared on the route.** The trunk factory
 * (`createApiApp`) mounts `createPrincipalMiddleware` +
 * `createDispatcherMiddleware` on the `/docs/*` path prefix (Hono's
 * `app.use("/docs/*", ...)`). Per-route `route.middleware` would
 * require the route file to reference concrete middleware instances,
 * which can only be bound at composition-root time — so either every
 * route becomes a factory accepting deps or middleware lives at the
 * trunk's prefix seam. The prefix seam is simpler and preserves the
 * "route is a pure const export" convention. `hc<AppType>` typing is
 * unaffected either way (middleware narrows Env, not Schema).
 *
 * **Audit + permission gate live inside the dispatcher**, not here.
 * The route handler does not re-check permissions or write audit
 * rows — invariant 5. A capability that reaches this handler has
 * already passed the gate and will have its `allow` / `error` /
 * `deny` row written by the dispatcher after the handler returns.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../../env";

const DOC_LIST_ID = CapabilityId("doc.list");

// Response body — mirrors the `docList` capability's output shape at
// the wire level (branded IDs serialize as strings). Declared here so
// the OpenAPI doc + RPC client types stay owned by the route, not
// imported from the capability (see file header §"Why the response
// schema duplicates the capability output shape").
const DocSummary = z
  .object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    collection_id: z.string().nullable(),
    visibility: z.enum(["workspace", "public", "private"]),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .openapi("DocSummary");

const DocListResponse = z
  .object({
    docs: z.array(DocSummary),
  })
  .openapi("DocListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/docs/list",
  tags: ["docs"],
  summary: "List all non-deleted docs in the caller's workspace.",
  responses: {
    200: {
      description: "Docs list.",
      content: { "application/json": { schema: DocListResponse } },
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
      description: "Permission denied.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
  },
});

export const list = defineOpenAPIRoute<typeof listRoute, ApiEnv, true>({
  route: listRoute,
  handler: async (c) => {
    // `c.var.principal` is attached by `createPrincipalMiddleware` and
    // guaranteed non-null by the time the handler runs (middleware
    // 401s otherwise). Narrow to UserPrincipal for tenant access —
    // agent principals also carry `workspace_id` but via a different
    // discriminant; when agent-routes land this narrow becomes a
    // principal-kind branch.
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const result = await dispatcher.dispatch({
      capability_id: DOC_LIST_ID,
      input: {},
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof DocListResponse>, 200);
  },
  addRoute: true,
});
