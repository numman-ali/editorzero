/**
 * `POST /collections/create` — collection.create surface (invariant 4).
 *
 * Metadata-only mutation route. Sibling of `/docs/create` but no
 * Y.Doc interaction (collections are pure relational metadata). The
 * dispatcher's write-path tx still governs the INSERT (ADR 0018 —
 * `METADATA_ONLY_CAPABILITIES`).
 *
 * **Status — 201 Created**, matching `/docs/create` (POST that
 * creates a resource returns 201).
 *
 * **404 response** on a non-existent / soft-deleted `parent_id`. The
 * capability surfaces this as `NotFoundError` with `subject_kind:
 * "collection"`; the global error mapper projects it to `{ error:
 * "not_found" }`.
 *
 * **409 response** — `SlugCollisionError` (sibling-slug collision,
 * `code: "slug_collision"`) when the derived slug is already taken by
 * a live sibling under the same parent. Added alongside slice 2's
 * `collection.update` retrofit so create + update have symmetric
 * error shaping (Codex review). Body is `{ error: "slug_collision" }`.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const COLLECTION_CREATE_ID = CapabilityId("collection.create");

const CreateRequest = z
  .object({
    title: z.string().trim().min(1, "title must not be empty or whitespace-only"),
    // Optional; absent === explicit `null` (both mean "root-level").
    parent_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .openapi("CollectionCreateRequest");

const CreateResponse = z
  .object({
    collection_id: z.string(),
    workspace_id: z.string(),
    parent_id: z.string().nullable(),
    title: z.string(),
    slug: z.string(),
    order_key: z.string(),
  })
  .openapi("CollectionCreateResponse");

const createRouteDef = createRoute({
  method: "post",
  path: "/collections/create",
  tags: ["collections"],
  summary: "Create a new collection in the caller's workspace.",
  request: {
    body: {
      content: { "application/json": { schema: CreateRequest } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Created — collection metadata.",
      content: { "application/json": { schema: CreateResponse } },
    },
    400: {
      description:
        "Validation error (empty/whitespace-only title, unattributable agent principal, or nesting depth exceeds the cap).",
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
    404: {
      description: "The referenced `parent_id` does not exist or is soft-deleted.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description: "Sibling-slug collision — derived slug is already taken by a live sibling.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("slug_collision") }),
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
      capability_id: COLLECTION_CREATE_ID,
      input,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof CreateResponse>, 201);
  },
  addRoute: true,
});
