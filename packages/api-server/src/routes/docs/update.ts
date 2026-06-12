/**
 * `POST /docs/update/:doc_id` — apply a batch of block mutations to a doc.
 *
 * The canonical F12 batch-mutation route. Code-first (ADR 0029 / 0034);
 * mirrors the golden `doc.create` / `doc.rename` shape. Delegates to
 * `doc.update`, which applies all ops inside `ctx.transact` via the
 * owned block layer (ADR 0038) → one Yjs transaction → one
 * `doc_updates` blob (single-tx atomicity per §6.5). Route-side is a
 * thin dispatcher-call.
 *
 * **Pattern P3 — path param + JSON body merged into one capability
 * input.** The route reuses the *single* `DocUpdateInputSchema` (ADR
 * 0034 — no re-declared wire copy) and splits it into the two request
 * pieces with `.pick()`: `{ doc_id }` validates the path param,
 * `{ ops }` validates the body. `.pick()` preserves each field's
 * `.transform()` (branded `c.req.valid` output — `doc_id` + every op's
 * `block_id`) and the schema's `.strict()` posture; the op members are
 * themselves `.strict()` discriminated-union arms, so unknown keys
 * anywhere in the op tree, an empty `ops` array, an unknown `op`
 * discriminator, an empty update patch, or a malformed
 * `expect_prior_content_hash` all reject at 400 pre-dispatcher. The
 * handler re-merges both validated halves into the dispatcher input —
 * the exact object shape `DocUpdateInputSchema` describes.
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
 * `DocUpdateOutputSchema` rather than asserting a type — the honest
 * `unknown`→typed narrowing plus a drift guard (a ZodError → 500, not a
 * silent lie).
 *
 * **Status codes.**
 *   200 — applied; body carries `applied_ops` with each op's post-state
 *         (post-image for insert/update, pre-image for remove).
 *   400 — malformed `doc_id`, bad op shape, unknown discriminator,
 *         missing required op field, or empty update patch (no-op).
 *   401 — unauthenticated (principal middleware rejected before the
 *         handler).
 *   403 — caller lacks `doc:write` or `block:write`.
 *   404 — doc missing/soft-deleted, or an op references a block_id
 *         that doesn't exist in the doc.
 *   409 — `expect_prior_content_hash` mismatch on an update/remove op
 *         (`stale_precondition`) or generic write conflict (`conflict`,
 *         dispatcher seq-unique retry exhaustion). Both map to 409; the
 *         `error` code discriminates retry policy.
 *
 * **Audit + permission + write-path tx live inside the dispatcher.** The
 * handler only dispatches; `ctx.transact` binding, the permission gate,
 * and the single CRDT write-path tx (ADR 0018 §6.5) are the dispatcher's.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocUpdateInputSchema, DocUpdateOutputSchema } from "@editorzero/schemas/doc/update";
import { Hono } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_UPDATE_ID = CapabilityId("doc.update");

// Derive the two request pieces from the one capability schema — `.pick()`
// preserves the field `.transform()`s and the `.strict()` posture.
const ParamSchema = DocUpdateInputSchema.pick({ doc_id: true });
const BodySchema = DocUpdateInputSchema.pick({ ops: true });

export const update = new Hono<ApiEnv>().post(
  "/update/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Apply a batch of block mutations (insert / update / remove) to a doc.",
      responses: {
        200: {
          description: "Applied — post-state projection for each op.",
          content: jsonContent(DocUpdateOutputSchema),
        },
        400: {
          description: "Validation error (malformed doc_id, bad op shape, unknown discriminator).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `doc:write` or `block:write`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Doc not found (or soft-deleted); or an op targeted a missing block_id.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "Stale precondition (expect_prior_content_hash mismatch) or write conflict. " +
            "`stale_precondition` = hash mismatch (caller re-fetches + retries with fresh " +
            "hash). `conflict` = dispatcher seq-unique retry exhaustion (caller backs off + " +
            "retries). Both map to 409; the `error` code discriminates retry policy.",
          content: jsonContent(z.object({ error: z.enum(["stale_precondition", "conflict"]) })),
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
          capability_id: DOC_UPDATE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocUpdateOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
