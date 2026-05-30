/**
 * `POST /docs/create` — mint a new document in the caller's workspace.
 *
 * **Golden reference for the code-first route shape (ADR 0029).** Every
 * capability route is a self-contained `Hono<ApiEnv>` sub-app built from
 * three chained handlers via the shared `factory.createHandlers(...)`:
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (summary, tags,
 *      per-status response schemas). Documents the contract; does not
 *      feed `hc`.
 *   2. `validator("json" | "param", Schema, hook)` — Standard-Schema
 *      request validation. The hook projects a parse failure to the
 *      `{ error: "validation_failed" }` envelope at 400 (the runtime
 *      wire shape; this 400, like the principal middleware's 401, is a
 *      cross-cutting middleware return and is intentionally not an `hc`
 *      arm — see `lib/errors.ts`).
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches, and returns the dispatcher's output through `c.json`.
 *      The dispatcher *throws* `EditorZeroError` subclasses; the handler
 *      catches and maps them with `errorResponse(c, err)` to explicit,
 *      literal-typed `c.json` returns — those explicit returns are what
 *      `hc<AppType>` reads to infer the error arm (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` — the
 * `user | agent` union. Capability routes serve agent principals too
 * (invariant 8); the handler only reads `workspace_id` (present on both
 * arms) and forwards `principal` to the dispatcher (which accepts the
 * union). `dispatch` returns `Promise<unknown>`; rather than *assert* a
 * type with `as`, the handler *parses* that `unknown` through the
 * capability's shared response schema (`docCreateOutputSchema.parse`) —
 * the honest `unknown`→typed narrowing, and a runtime guard that the
 * dispatcher output still satisfies the published contract (a drift
 * surfaces as a ZodError → 500, not a silent lie). Every capability
 * route follows this: zero `as` casts; narrow with a parse or a
 * `@editorzero/principal` type guard, never an assertion.
 *
 * The route mounts at a path **relative** to its domain (`/create`); the
 * `docs` domain mounts at `/docs` on the trunk, so the external path is
 * `/docs/create`. `hc<AppType>` reconstructs `client.docs.create.$post`.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `docCreateInputSchema` / `docCreateOutputSchema` from
 * `@editorzero/schemas/doc/create` are the single source the capability
 * also consumes. Each field's `.transform()` encodes the wire↔branded
 * shape change in one place: `validator("json", docCreateInputSchema)`
 * types the `hc` request body as the wire shape (`InferInput` — plain
 * UUIDv7 strings) while `c.req.valid("json")` hands the handler the
 * branded `InferOutput`; `resolver` / `describeRoute` generate the
 * OpenAPI request + response from the *input* side, so the spec stays
 * wire-shaped (UUIDv7 pattern preserved, brands invisible to external
 * clients). No wire copy drifts from the capability because there is no
 * copy — the kernel's `Capability.input: ZodType<I>` erasure that once
 * forced re-declaration is bypassed by importing the schema directly.
 *
 * **Status code — 201 Created.** A POST that creates a resource returns
 * 201. No `Location` header: a doc's resource URI is not `/docs/<id>`
 * (reads go through `GET /docs/get/:doc_id`), so a `Location` would
 * mislead; the response body carries `doc_id` for follow-ups.
 *
 * **404 response** when the optional `collection_id` names a collection
 * that does not exist or is soft-deleted — the capability surfaces a
 * `NotFoundError { subject_kind: "collection" }`; `errorResponse` projects
 * it to `{ error: "not_found" }`.
 *
 * **409 response** — `SlugCollisionError` (`code: "slug_collision"`) when
 * the title-derived slug is already taken by a live sibling in the same
 * scope (workspace root, or the target collection). Body is
 * `{ error: "slug_collision" }`.
 *
 * **Audit + permission + write-path tx live inside the dispatcher.** The
 * handler only dispatches; `ctx.transact` binding, the permission gate,
 * and the single write-path SQL tx (ADR 0018 §6.4) are the dispatcher's.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocCreateInputSchema, DocCreateOutputSchema } from "@editorzero/schemas/doc/create";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_CREATE_ID = CapabilityId("doc.create");

export const create = new Hono<ApiEnv>().post(
  "/create",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Create a new document in the caller's workspace.",
      responses: {
        201: {
          description: "Created — doc metadata + pre-minted seed block IDs.",
          content: jsonContent(DocCreateOutputSchema),
        },
        400: {
          description: "Validation error (empty/whitespace title, or malformed collection_id).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `doc:write`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "The referenced `collection_id` does not exist or is soft-deleted.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description: "Sibling-slug collision — derived slug is already taken by a live sibling.",
          content: jsonContent(errEnvelope("slug_collision")),
        },
      },
    }),
    validator("json", DocCreateInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("json");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: DOC_CREATE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocCreateOutputSchema.parse(result), 201);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
