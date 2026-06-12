/**
 * `POST /docs/publish/:doc_id` — publish a doc: mint its public URL
 * slug and stamp `published_at` (ADR 0040 Step 5).
 *
 * Code-first route shape (ADR 0029) — mirrors the golden `create.ts`:
 * a self-contained `Hono<ApiEnv>` sub-app built from three chained
 * handlers via `factory.createHandlers(...)`:
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only. Documents the
 *      contract; does not feed `hc`.
 *   2. `validator("param", DocPublishInputSchema, hook)` — Standard-Schema
 *      path-param validation. The capability's input IS the single-id
 *      object (`{ doc_id }`), so the shared `DocPublishInputSchema` is
 *      reused verbatim as the param validator (PATTERN P2 — no separate
 *      path schema to drift). The hook projects a parse failure to the
 *      `{ error: "validation_failed" }` envelope at 400 (a cross-cutting
 *      middleware return, intentionally not an `hc` arm — see `lib/errors.ts`).
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches `doc.publish` with the param-derived `input`, and
 *      returns the dispatcher's output through `c.json` at 200. The
 *      dispatcher *throws* `EditorZeroError` subclasses; the handler
 *      catches and maps them with `errorResponse(c, err)` — those
 *      explicit `c.json` returns are what `hc<AppType>` reads to infer
 *      the error arms (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` (no
 * `UserPrincipal` assertion); the handler only reads `workspace_id`
 * (present on both arms) and forwards the union to the dispatcher.
 * `dispatch` returns `Promise<unknown>`; the handler *parses* it through
 * `DocPublishOutputSchema.parse` rather than asserting — the honest
 * `unknown`→typed narrowing, and a runtime guard that the dispatcher
 * output still satisfies the published contract.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `DocPublishInputSchema` / `DocPublishOutputSchema` from
 * `@editorzero/schemas/doc/publish` are the single source the capability
 * also consumes. `validator("param", DocPublishInputSchema)` types the
 * `hc` request as the wire shape (plain UUIDv7 string) while
 * `c.req.valid("param")` hands the handler the branded shape; `resolver`
 * / `describeRoute` generate the OpenAPI from the *input* side, so the
 * spec stays wire-shaped. No wire copy drifts because there is no copy.
 *
 * **Status code — 200 OK.** Publish mutates an existing doc's metadata
 * (`published_slug` minted, `published_at` stamped, `render_version`
 * bumped); it does not create a resource, so 200 rather than 201.
 *
 * **No request body.** The capability's only input is the path-param
 * `doc_id`; an empty POST is the expected shape.
 *
 * **Audit + permission + write-path tx live inside the dispatcher.** The
 * dispatcher opens one `BEGIN IMMEDIATE`, runs SELECT+UPDATE on the `docs`
 * row (no `ctx.transact`, so no `doc_updates`), writes the audit rows in
 * the same tx, and commits atomically. The handler only dispatches.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocPublishInputSchema, DocPublishOutputSchema } from "@editorzero/schemas/doc/publish";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_PUBLISH_ID = CapabilityId("doc.publish");

export const publish = new Hono<ApiEnv>().post(
  "/publish/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Publish a doc — mint its public URL slug and stamp published_at.",
      responses: {
        200: {
          description:
            "Doc published (or re-asserted): published_slug minted or kept stable, published_at stamped or kept, render_version bumped.",
          content: jsonContent(DocPublishOutputSchema),
        },
        400: {
          description: "Validation error (malformed doc_id).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `doc:publish`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Doc not found (or soft-deleted).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", DocPublishInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("param");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: DOC_PUBLISH_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocPublishOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
