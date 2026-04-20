/**
 * `GET /docs/get/:doc_id` — read a single doc's metadata + block-array
 * projection (first read-path route that exercises `ctx.transact`).
 *
 * Same three-part route shape as `routes/docs/{list,create}`:
 *
 *   1. zod input (path param) + output schemas declared on the route.
 *   2. Handler reads `c.var.principal` + `c.var.dispatcher`, dispatches
 *      `doc.get`, returns the dispatcher's output as-is through
 *      `c.json` with status 200.
 *   3. No permission / audit logic here — the dispatcher owns both.
 *
 * **Why this route validates `doc_id` on the path, not in a body.**
 * GET requests don't carry bodies in standard HTTP; the doc id lives
 * in the URL. zod's `z.string().uuid()` runs on the path param, and
 * the capability's own `InputSchema` re-validates `{ doc_id }` with
 * `z.uuid({ version: "v7" })` before the handler runs. Two-layer
 * parse is intentional — the route schema powers OpenAPI + `hc` RPC
 * typing, the capability schema is the authoritative boundary for
 * the dispatcher.
 *
 * **Response body is `doc.get`'s output shape flattened to wire form.**
 * Branded IDs serialise as plain strings (same pattern as `list`).
 * The `blocks` field is `z.array(z.unknown())` here — BlockNote's
 * full polymorphic block union would mirror the entire block-type
 * registry into this schema, which the capability already declined
 * to do (see `doc/get.ts` § "Output"). Registry-driven codegen is
 * the eventual single source of truth for both; today the API
 * contract advertises "array of opaque JSON" and lets the
 * capability's own `readBlocks` guarantee correctness.
 *
 * **Status codes.**
 *   200 — happy path. Doc exists, blocks projected.
 *   400 — malformed doc_id (not a v7 UUID). Surfaced by the route's
 *         zod validator before the dispatcher runs.
 *   401 — unauthenticated. Middleware chain at the trunk's `/docs/*`
 *         prefix rejects before this handler is reached.
 *   403 — permission denied (caller lacks `doc:read`). Dispatcher
 *         emits deny-audit row.
 *   404 — doc missing or soft-deleted. Capability throws
 *         `NotFoundError`; dispatcher projects as error-audit; the
 *         framework's error mapper returns 404.
 *   500 — doc row exists but Y.Doc is empty (inconsistent state).
 *         Capability throws `InternalError`; dispatcher projects
 *         as error-audit; framework returns 500.
 *
 * The route doesn't enumerate every error branch in its zod response
 * map — middleware / error-mapper ownership of 401/403/404/500
 * message shape is established by `routes/docs/{list,create}` and
 * stays consistent. This route only documents the ones a schema-
 * typed RPC client cares about for happy-path typing.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../../env";

const DOC_GET_ID = CapabilityId("doc.get");

// Path parameter schema — 400s on non-UUIDv7 strings. `z.uuid` with
// `version: "v7"` matches what the capability's InputSchema does; the
// brand narrowing (`DocId`) happens inside the capability's own parse.
const GetParams = z
  .object({
    doc_id: z.uuid({ version: "v7", message: "doc_id must be a UUIDv7" }),
  })
  .openapi("DocGetParams");

// Response schema — mirrors `doc.get` OutputSchema at wire level:
// branded IDs are strings, `blocks` is opaque (see file header).
const DocMeta = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    title: z.string(),
    slug: z.string(),
    collection_id: z.string().nullable(),
    visibility: z.enum(["workspace", "public", "private"]),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .openapi("DocGetMeta");

const GetResponse = z
  .object({
    doc: DocMeta,
    blocks: z.array(z.unknown()),
  })
  .openapi("DocGetResponse");

const getRouteDef = createRoute({
  method: "get",
  path: "/docs/get/:doc_id",
  tags: ["docs"],
  summary: "Read a single doc's metadata and block-array projection.",
  request: {
    params: GetParams,
  },
  responses: {
    200: {
      description: "Doc metadata + blocks from the live Y.Doc.",
      content: { "application/json": { schema: GetResponse } },
    },
    400: {
      description: "Validation error (malformed doc_id).",
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
      description: "Permission denied — caller lacks `doc:read`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
    404: {
      description: "Doc not found (or soft-deleted).",
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
    const { doc_id } = c.req.valid("param");
    const result = await dispatcher.dispatch({
      capability_id: DOC_GET_ID,
      input: { doc_id },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof GetResponse>, 200);
  },
  addRoute: true,
});
