/**
 * `POST /docs/delete/:doc_id` — soft-delete a doc.
 *
 * Code-first route (ADR 0029); same three-part shape as the golden
 * `create.ts` — `describeRoute` (OpenAPI metadata) + `validator`
 * (Standard-Schema request validation) + handler — composed through the
 * shared `factory.createHandlers(...)` so `hc<AppType>` keeps input +
 * output inference across `.route()` composition.
 *
 * **Pattern P2 — path param IS the capability input.** `doc.delete`'s
 * sole input is the single-id object `{ doc_id }`, which is exactly what
 * `DocDeleteInputSchema` describes (ADR 0034). So the route reuses that
 * shared schema *directly* as the `"param"` validator rather than
 * re-declaring a local `DeleteParams` — `validator("param", …)` types the
 * `hc` request path-param as the wire shape (plain UUIDv7 string) while
 * `c.req.valid("param")` hands the handler the branded `{ doc_id: DocId }`.
 * `DocDeleteOutputSchema` is reused the same way for the response. No wire
 * copy drifts from the capability because there is no copy.
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` (the
 * `user | agent` union); the handler only reads `workspace_id` (on both
 * arms) and forwards the principal to the dispatcher. `dispatch` returns
 * `Promise<unknown>`; rather than *assert* a type, the handler *parses*
 * that `unknown` through `DocDeleteOutputSchema.parse` — the honest
 * narrowing, and a runtime guard that the dispatcher output still
 * satisfies the published contract (drift → ZodError → 500, not a silent
 * lie). The sole literal `as const` is the validator hook's
 * `{ error: "validation_failed" }` envelope.
 *
 * **Metadata-only mutation.** Mutates `docs.deleted_at` + bumps
 * `visibility_version` in the dispatcher's write-path tx; no Y.Doc
 * touching, no `doc_updates` row. The permission gate, audit entry, and
 * write-path tx all live inside the dispatcher; the handler only
 * dispatches.
 *
 * **Why POST.** Capability changes server state. Path is
 * capability-shaped (`/docs/delete/:id`) rather than subresource-shaped
 * (`DELETE /docs/:id`) — matches the convention the rest of the `docs/*`
 * slice uses.
 *
 * **Status codes.**
 *   200 — soft-deleted: `deleted_at` set, `visibility_version` bumped.
 *         Body carries `{ doc_id, deleted_at, visibility_version }`.
 *   400 — malformed doc_id (not a v7 UUID); validator hook → envelope.
 *   401 — unauthenticated (principal middleware; declaration only).
 *   403 — permission denied; caller lacks `doc:delete`.
 *   404 — doc missing OR already soft-deleted. Re-delete is an honest 404
 *         because the recovery-window anchor would slide otherwise.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocDeleteInputSchema, DocDeleteOutputSchema } from "@editorzero/schemas/doc/delete";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_DELETE_ID = CapabilityId("doc.delete");

export const del = new Hono<ApiEnv>().post(
  "/delete/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Soft-delete a doc.",
      responses: {
        200: {
          description:
            "Doc soft-deleted; deleted_at anchors the recovery window, visibility_version bumped.",
          content: jsonContent(DocDeleteOutputSchema),
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
          description: "Permission denied — caller lacks `doc:delete`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Doc not found, or already soft-deleted.",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", DocDeleteInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("param");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: DOC_DELETE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocDeleteOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
