/**
 * `POST /docs/rename/:doc_id` — rename a doc.
 *
 * Code-first route (ADR 0029 / 0034); mirrors the golden `doc.create`
 * shape. The capability threads through `ctx.transact` to mutate the
 * Y.Doc's title block; the route itself stays a thin dispatcher-call,
 * same shape as every other `docs/*` route.
 *
 * **Pattern P3 — path param + JSON body merged into one capability
 * input.** The route reuses the *single* `DocRenameInputSchema` (ADR
 * 0034 — no re-declared wire copy) and splits it into the two request
 * pieces with `.pick()`: `{ doc_id }` validates the path param,
 * `{ title }` validates the body. `.pick()` preserves each field's
 * `.transform()` (branded `c.req.valid` output) and the schema's
 * `.strict()` (unknown body keys → 400). The handler re-merges both
 * validated halves into the dispatcher input — the exact object shape
 * the capability's `DocRenameInputSchema` describes.
 *
 * Two `validator` middlewares (`"param"` + `"json"`) each carry the same
 * hook projecting a parse failure to the `{ error: "validation_failed" }`
 * envelope at 400 — the runtime wire shape (this 400, like the principal
 * middleware's 401, is a cross-cutting middleware return, intentionally
 * not an `hc` arm; see `lib/errors.ts`).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` (the
 * `user | agent` union); the handler only reads `workspace_id` (on both
 * arms) and forwards the principal to the dispatcher. `dispatch` returns
 * `Promise<unknown>`; the handler *parses* that through
 * `DocRenameOutputSchema` rather than asserting a type — the honest
 * narrowing plus a drift guard (a ZodError → 500, not a silent lie).
 *
 * **Status codes.**
 *   200 — renamed; body carries the post-rename projection
 *         `{ doc_id, title, slug, updated_at }`. No 201 — rename
 *         mutates an existing doc, doesn't create.
 *   400 — malformed `doc_id` (not v7 UUID) or empty/whitespace-only
 *         title.
 *   401 — unauthenticated (principal middleware rejected before the
 *         handler).
 *   403 — permission denied; caller lacks `doc:write`.
 *   404 — doc missing or soft-deleted (rename is a live-doc op, not
 *         resurrection — callers use `doc.restore` first).
 *
 * **Audit + write-path tx live inside the dispatcher.** The dispatcher
 * opens one `BEGIN IMMEDIATE`, runs the handler (which UPDATEs
 * `docs.title/slug/updated_at` then threads through `ctx.transact` to
 * rewrite the Y.Doc's heading-1 block), emits one `outbox(doc.updated)`
 * via the bound sync writer + the audit row in the same tx, and commits
 * atomically. Route-side is thin.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocRenameInputSchema, DocRenameOutputSchema } from "@editorzero/schemas/doc/rename";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_RENAME_ID = CapabilityId("doc.rename");

// Derive the two request pieces from the one capability schema — `.pick()`
// preserves the field `.transform()`s and the `.strict()` posture.
const ParamSchema = DocRenameInputSchema.pick({ doc_id: true });
const BodySchema = DocRenameInputSchema.pick({ title: true });

export const rename = new Hono<ApiEnv>().post(
  "/rename/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Rename a doc — updates the title-block heading + the docs.title bridge.",
      responses: {
        200: {
          description: "Renamed — post-state projection.",
          content: jsonContent(DocRenameOutputSchema),
        },
        400: {
          description: "Validation error (malformed doc_id or empty/whitespace-only title).",
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
          description: "Doc not found (or soft-deleted).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", ParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", BodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: DOC_RENAME_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocRenameOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
