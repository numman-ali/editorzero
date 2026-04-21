/**
 * `POST /docs/update/:doc_id` — apply a batch of block mutations to a doc.
 *
 * The canonical F12 batch-mutation route. Delegates to `doc.update`,
 * which threads through `ctx.transact` + `withLiveEditor` to apply all
 * ops in one `editor.transact` → one `doc_updates` blob (single-tx
 * atomicity per §6.5).
 *
 * **Request body.** `{ ops: [...] }` — an array of discriminated-union
 * op entries. Slice 1 supports three literals — `insert`, `update`,
 * `remove`. `move` and `set_visibility` return zod `invalid_union_
 * discriminator` 400 until their follow-on slices land.
 *
 * **Status codes.**
 *   200 — applied; body carries `applied_ops` with each op's post-state
 *         (post-image for insert/update, pre-image for remove).
 *   400 — malformed `doc_id`, bad op shape, unknown discriminator, or
 *         missing required op field.
 *   401 — unauthenticated.
 *   403 — caller lacks `doc:write` or `block:write`.
 *   404 — doc missing/soft-deleted, or an op references a block_id
 *         that doesn't exist in the doc.
 *   409 — `expect_prior_content_hash` mismatch on an update/remove op
 *         (`stale_precondition`) or generic conflict.
 *
 * **Body vs path.** Path carries `doc_id` (the mutation target);
 * body carries the ops. Matches `doc.rename`'s `POST /docs/rename/
 * :doc_id` + body={title} layout. Duplicating the op-schema definitions
 * here (rather than importing the capability's `InputSchema`) keeps
 * the OpenAPI contract + `hc<AppType>` RPC types owned by the route —
 * same pattern as `doc/create` and `doc/rename`.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const DOC_UPDATE_ID = CapabilityId("doc.update");

// ── Path + body schemas ──────────────────────────────────────────────────

const UpdateParams = z
  .object({
    doc_id: z.uuid({ version: "v7", message: "doc_id must be a UUIDv7" }),
  })
  .openapi("DocUpdateParams");

const BlockIdString = z.uuid({ version: "v7", message: "block_id must be a UUIDv7" });
const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a 64-char lowercase hex sha256 digest");

const InsertBlockBody = z
  .object({
    type: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    content: z.unknown().optional(),
  })
  .strict();

const UpdatePatchBody = z
  .object({
    type: z.string().min(1).optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    content: z.unknown().optional(),
  })
  .strict();

const InsertOpBody = z
  .object({
    op: z.literal("insert"),
    block: InsertBlockBody,
    after_block_id: BlockIdString.nullable(),
  })
  .strict();

const UpdateOpBody = z
  .object({
    op: z.literal("update"),
    block_id: BlockIdString,
    patch: UpdatePatchBody,
    expect_prior_content_hash: Sha256Hex.optional(),
  })
  .strict();

const RemoveOpBody = z
  .object({
    op: z.literal("remove"),
    block_id: BlockIdString,
    expect_prior_content_hash: Sha256Hex.optional(),
  })
  .strict();

const OpBody = z.discriminatedUnion("op", [InsertOpBody, UpdateOpBody, RemoveOpBody]);

const UpdateRequest = z
  .object({
    ops: z.array(OpBody).min(1, "ops must contain at least one op"),
  })
  .strict()
  .openapi("DocUpdateRequest");

// ── Response schema ──────────────────────────────────────────────────────
//
// Echoes the applied ops in post-state shape. Keep the shape mirroring
// the capability's output — plain strings on the wire for branded IDs.

const BlockPostStateBody = z.object({
  id: z.string(),
  doc_id: z.string(),
  type: z.string(),
  parent_block_id: z.string().nullable(),
  order_key: z.string(),
  content_json: z.unknown(),
  visibility: z.enum(["default", "internal", "public"]),
});

const AppliedOpBody = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("insert"),
      block: BlockPostStateBody,
      after_block_id: z.string().nullable(),
      parent_block_id: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      block_id: z.string(),
      post: BlockPostStateBody,
    })
    .strict(),
  z
    .object({
      op: z.literal("remove"),
      block_id: z.string(),
      preimage: BlockPostStateBody,
    })
    .strict(),
]);

const UpdateResponse = z
  .object({
    doc_id: z.string(),
    applied_ops: z.array(AppliedOpBody),
    updated_at: z.number(),
  })
  .openapi("DocUpdateResponse");

// ── Route definition ─────────────────────────────────────────────────────

const updateRouteDef = createRoute({
  method: "post",
  path: "/docs/update/:doc_id",
  tags: ["docs"],
  summary: "Apply a batch of block mutations (insert / update / remove) to a doc.",
  request: {
    params: UpdateParams,
    body: {
      content: { "application/json": { schema: UpdateRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Applied — post-state projection for each op.",
      content: { "application/json": { schema: UpdateResponse } },
    },
    400: {
      description: "Validation error (malformed doc_id, bad op shape, unknown discriminator).",
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
      description: "Permission denied — caller lacks `doc:write` or `block:write`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
    404: {
      description: "Doc not found (or soft-deleted); or an op targeted a missing block_id.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description: "Stale precondition (expect_prior_content_hash mismatch) or write conflict.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("conflict") }),
        },
      },
    },
  },
});

export const update = defineOpenAPIRoute<typeof updateRouteDef, ApiEnv, true>({
  route: updateRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const { doc_id } = c.req.valid("param");
    const { ops } = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: DOC_UPDATE_ID,
      input: { doc_id, ops },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof UpdateResponse>, 200);
  },
  addRoute: true,
});
