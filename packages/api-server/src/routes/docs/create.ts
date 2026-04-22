/**
 * `POST /docs/create` — mint a new document in the caller's workspace.
 *
 * Second capability route (after `doc.list`); first write-path route.
 * Shape follows the same three-part pattern:
 *
 *   1. zod input + output schemas declared on the route.
 *   2. Handler reads `c.var.principal` + `c.var.dispatcher` and
 *      dispatches `doc.create`.
 *   3. Capability output returns as-is through `c.json` with status
 *      201 — the dispatcher's parse pass has already validated shape.
 *
 * **Request body schema.** Matches `doc.create`'s `InputSchema` exactly
 * (`{ title: string }`, strict). Duplicated locally for the same
 * reasons listed on `routes/docs/list/index.ts`: the OpenAPI doc +
 * hc<AppType> RPC types stay owned by the route, not imported from the
 * capability's zod schema (which uses branded-transform outputs that
 * don't match the wire form).
 *
 * **Response body schema.** Mirrors `doc.create`'s output shape —
 * `doc_id`, `workspace_id`, `collection_id`, metadata fields,
 * `seed_blocks` (the pre-minted header + paragraph block IDs the
 * handler seeded the Y.Doc with). Branded IDs serialise as plain
 * strings on the wire; the local schema says `string` so the OpenAPI
 * contract is explicit.
 *
 * **Status code — 201 Created.** HTTP semantics: a POST that creates
 * a new resource returns 201, not 200. The `doc.list` read route
 * returns 200 (no resource created). This is the first distinction
 * between read and write routes on status codes; future write routes
 * (e.g. `POST /docs/update`) return 200 because they modify existing
 * state rather than creating. `POST /docs/delete` also returns 200
 * (soft-delete is a mutation, not creation).
 *
 * **No `Location` header.** REST convention says a 201 should set
 * `Location: /docs/<id>`. We intentionally don't — the resource URI
 * for a doc isn't `/docs/<id>` (we use `GET /docs/get/:doc_id` +
 * capability-style paths), and surfacing a `Location` that doesn't
 * match our URL scheme would be misleading. The response body
 * carries `doc_id` which callers use in follow-up requests.
 *
 * **Audit + permission + write-path tx live inside the dispatcher.**
 * `ctx.transact` is bound to a `HocuspocusSync`-backed service at
 * composition time (`createApiDispatcher({ sync })`); the handler
 * seeds blocks through that binding and the dispatcher commits the
 * `docs` INSERT + `doc_updates` + `audit_events(allow)` + outbox rows
 * in one SQL transaction (ADR 0018 §6.4 / P3.6e). The route handler
 * itself does none of this — it only dispatches.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const DOC_CREATE_ID = CapabilityId("doc.create");

const CreateRequest = z
  .object({
    title: z.string().trim().min(1, "title must not be empty or whitespace-only"),
    // Optional collection parent — mirrors `doc.create`'s capability
    // input. `null` (explicit workspace root) is distinct from
    // "omitted" on the wire; both coerce to null on the DB side.
    // Added as part of slice 3 so the collections routes and the
    // doc-move route compose end-to-end. The handler's tenant-scoped
    // SELECT + 404-on-missing gate is unchanged.
    collection_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .openapi("DocCreateRequest");

const SeedBlock = z
  .object({
    id: z.string(),
    type: z.string(),
    props: z.record(z.string(), z.unknown()).optional(),
    content: z.unknown().optional(),
  })
  .openapi("DocCreateSeedBlock");

const CreateResponse = z
  .object({
    doc_id: z.string(),
    workspace_id: z.string(),
    collection_id: z.string().nullable(),
    title: z.string(),
    slug: z.string(),
    order_key: z.string(),
    visibility: z.enum(["workspace", "private"]),
    seed_blocks: z.array(SeedBlock),
  })
  .openapi("DocCreateResponse");

const createRouteDef = createRoute({
  method: "post",
  path: "/docs/create",
  tags: ["docs"],
  summary: "Create a new document in the caller's workspace.",
  request: {
    body: {
      content: { "application/json": { schema: CreateRequest } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Created — doc metadata + pre-minted seed block IDs.",
      content: { "application/json": { schema: CreateResponse } },
    },
    400: {
      description:
        "Validation error (empty or whitespace-only title, or unattributable agent principal).",
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
      description: "Permission denied — caller lacks `doc:write`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
  },
});

export const create = defineOpenAPIRoute<typeof createRouteDef, ApiEnv, true>({
  route: createRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const input = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: DOC_CREATE_ID,
      input,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof CreateResponse>, 201);
  },
  addRoute: true,
});
