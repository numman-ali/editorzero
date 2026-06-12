/**
 * `POST /docs/apply_update/:doc_id` — apply a raw Yjs update to a doc.
 *
 * The protocol-lane sibling of `POST /docs/update/:doc_id` (ADR 0043
 * Decision 2): where `doc.update` takes semantic block ops, this route
 * takes an opaque base64 Yjs delta — the same payload the WS adapter
 * dispatches per update frame — and gives HTTP/CLI/MCP callers
 * (invariant 4) the identical raw-delta push. Code-first (ADR 0029 /
 * 0034); delegates everything to `doc.apply_update`.
 *
 * **Pattern P3 — path param + JSON body merged into one capability
 * input.** The route reuses the *single* `DocApplyUpdateInputSchema`
 * (ADR 0034 — no re-declared wire copy) split with `.pick()`:
 * `{ doc_id }` validates the path param, `{ update }` validates the
 * body. The base64 alphabet regex, the `% 4` padding refinement, and
 * the 10 MiB char cap all reject at 400 pre-dispatcher.
 *
 * **No type casts (`as`).** `dispatch` returns `Promise<unknown>`; the
 * handler parses through `DocApplyUpdateOutputSchema` — honest
 * narrowing plus a drift guard (a ZodError → 500, not a silent lie).
 *
 * **Status codes.**
 *   200 — applied (`applied: true`, body carries the exact persisted
 *         post-repair blob + minted block ids) or the marked no-op
 *         (`applied: false`, `update_b64: null` — the update was fully
 *         contained in current state).
 *   400 — malformed `doc_id`; malformed base64 (alphabet / padding /
 *         size cap); or a refused delta (`validation_failed` from the
 *         foreign-update lane: not integrable, foreign shared type,
 *         schema violation, duplicate block id).
 *   401 — unauthenticated (principal middleware rejected).
 *   403 — caller lacks `doc:write` or `block:write`.
 *   404 — doc missing or soft-deleted.
 *   409 — generic write conflict (dispatcher seq-unique retry
 *         exhaustion); caller backs off + retries.
 *
 * **Audit + permission + write-path tx live inside the dispatcher.**
 */

import { CapabilityId } from "@editorzero/ids";
import {
  DocApplyUpdateInputSchema,
  DocApplyUpdateOutputSchema,
} from "@editorzero/schemas/doc/apply_update";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_APPLY_UPDATE_ID = CapabilityId("doc.apply_update");

// Derive the two request pieces from the one capability schema — `.pick()`
// preserves the field validations and the `.strict()` posture.
const ParamSchema = DocApplyUpdateInputSchema.pick({ doc_id: true });
const BodySchema = DocApplyUpdateInputSchema.pick({ update: true });

export const applyUpdate = new Hono<ApiEnv>().post(
  "/apply_update/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Apply a raw Yjs update to a doc's CRDT content (validated, id-repaired, audited).",
      responses: {
        200: {
          description:
            "Applied — body carries the exact persisted post-repair blob and any " +
            "server-minted block ids; or the marked no-op (`applied: false`) when the " +
            "update was fully contained in current state.",
          content: jsonContent(DocApplyUpdateOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed doc_id or base64 (pre-dispatch), or a refused " +
            "delta (not integrable, foreign shared type, schema violation, duplicate " +
            "block id).",
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
          description: "Doc not found (or soft-deleted).",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description: "Write conflict — dispatcher seq-unique retry exhaustion; back off + retry.",
          content: jsonContent(errEnvelope("conflict")),
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
          capability_id: DOC_APPLY_UPDATE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocApplyUpdateOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
