/**
 * `POST /docs/restore/:doc_id` — revive a soft-deleted doc.
 *
 * Inverse of `POST /docs/delete/:doc_id`; same metadata-only lane. Flips
 * `docs.deleted_at` from non-NULL back to NULL + bumps `render_version`.
 * See `routes/docs/delete.ts` for the fuller route-posture discussion; this
 * doc-block keeps only the deltas.
 *
 * Code-first route (ADR 0029); same three-part shape as the golden
 * `create.ts` — `describeRoute` (OpenAPI metadata) + `validator`
 * (Standard-Schema request validation) + handler — composed through the
 * shared `factory.createHandlers(...)` so `hc<AppType>` keeps input +
 * output inference across `.route()` composition.
 *
 * **Pattern P2 — path param IS the capability input.** `doc.restore`'s
 * sole input is the single-id object `{ doc_id }`, which is exactly what
 * `DocRestoreInputSchema` describes (ADR 0034). So the route reuses that
 * shared schema *directly* as the `"param"` validator rather than
 * re-declaring a local `RestoreParams` — `validator("param", …)` types the
 * `hc` request path-param as the wire shape (plain UUIDv7 string) while
 * `c.req.valid("param")` hands the handler the branded `{ doc_id: DocId }`.
 * `DocRestoreOutputSchema` is reused the same way for the response. No wire
 * copy drifts from the capability because there is no copy (ADR 0034).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` (the
 * `user | agent` union); the handler only reads `workspace_id` (on both
 * arms) and forwards the principal to the dispatcher. `dispatch` returns
 * `Promise<unknown>`; rather than *assert* a type, the handler *parses*
 * that `unknown` through `DocRestoreOutputSchema.parse` — the honest
 * narrowing, and a runtime guard that the dispatcher output still
 * satisfies the published contract (drift → ZodError → 500, not a silent
 * lie). The sole literal `as const` is the validator hook's
 * `{ error: "validation_failed" }` envelope.
 *
 * **Status codes.**
 *   200 — restored: `deleted_at` cleared, `render_version` bumped.
 *         Body carries `{ doc_id, render_version }`. No `restored_at`
 *         field (audit envelope owns event time; see capability doc-block).
 *   400 — malformed doc_id (not a v7 UUID); validator hook → envelope.
 *   401 — unauthenticated (principal middleware; declaration only).
 *   403 — permission denied; caller lacks `doc:delete` (same scope as
 *         delete — symmetric rollback rights).
 *   404 — doc missing OR already live (not-trashed). Restore on an
 *         already-live doc is 404 to avoid no-op audit rows.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocRestoreInputSchema, DocRestoreOutputSchema } from "@editorzero/schemas/doc/restore";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_RESTORE_ID = CapabilityId("doc.restore");

export const restore = new Hono<ApiEnv>().post(
  "/restore/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Restore a soft-deleted doc (inverse of doc.delete).",
      responses: {
        200: {
          description: "Doc restored; deleted_at cleared, render_version bumped.",
          content: jsonContent(DocRestoreOutputSchema),
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
          description: "Doc not found, or already live (not soft-deleted).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", DocRestoreInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("param");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: DOC_RESTORE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocRestoreOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
