/**
 * `POST /docs/move/:doc_id` — doc.move surface (invariant 4).
 *
 * Metadata-only mutation. Re-parents a doc under a different collection
 * (or the workspace root via `new_collection_id: null`). Docs are tree
 * leaves, so the shape is strictly simpler than `collection.move` — no
 * cycle walk, no subtree-height check. Target existence + target-scope
 * slug uniqueness are the base preconditions.
 *
 * **Cross-boundary moves are audited ACL transitions (ADR 0040 §7).**
 * When the move crosses the doc's space-bucket boundary the handler
 * requires `acl_policy` (`adopt_baseline` | `keep_grants`) and demands
 * administer authority on the source + placement standing in the
 * destination; the response then carries `acl_transition` (the applied
 * policy, both space bindings, and full preimages of every dropped
 * grant row). Same-bucket moves must OMIT `acl_policy`. Both
 * conditional rails are typed 400s — see the handler header in
 * `@editorzero/capabilities` for the full contract.
 *
 * **Code-first shape (ADR 0029) — pattern P3 (path param + JSON body).**
 * The capability input merges a path-param `doc_id` with a JSON-body
 * `new_collection_id`. Rather than re-declare two wire schemas, both
 * validators are *derived from the one shared capability schema*
 * (`DocMoveInputSchema`, ADR 0034) via `.pick()` — which preserves each
 * field's `.transform()` and the parent's `.strict()`:
 *   - `ParamSchema = DocMoveInputSchema.pick({ doc_id: true })`
 *   - `BodySchema  = DocMoveInputSchema.pick({ new_collection_id: true })`
 * Two `validator(...)` middlewares parse the two request locations; the
 * handler re-merges `c.req.valid("param")` + `c.req.valid("json")` into
 * the single capability input. Both validators share the hook that
 * projects a parse failure to `{ error: "validation_failed" }` at 400 —
 * the runtime wire shape (this 400, like the principal middleware's 401,
 * is a cross-cutting middleware return, intentionally not an `hc` arm;
 * see `lib/errors.ts`).
 *
 * **No type casts (`as`)** beyond the hook's literal `as const`.
 * `c.var.principal` stays the `Principal` union (capability routes serve
 * agent principals too, invariant 8); the handler reads only
 * `workspace_id` (present on both arms). `dispatch` returns
 * `Promise<unknown>`; the handler *parses* that through
 * `DocMoveOutputSchema` rather than asserting a type — the honest
 * `unknown`→branded narrowing, and a runtime guard that dispatcher output
 * still satisfies the published contract (drift → ZodError → 500, not a
 * silent lie). The dispatcher *throws* `EditorZeroError` subclasses; the
 * handler catches and maps them with `errorResponse(c, err)` to explicit,
 * literal-typed `c.json` returns — those returns are what `hc<AppType>`
 * reads to infer the error arm (ADR 0029 §4).
 *
 * The route mounts at a path **relative** to its domain (`/move/:doc_id`);
 * the `docs` domain mounts at `/docs` on the trunk, so the external path
 * is `/docs/move/:doc_id`.
 *
 * **Status — 200 OK** (metadata mutation, no resource minted).
 * **400** — malformed body/path param, OR the conditional `acl_policy`
 * rails: missing on a crossing (`acl_transition_policy_required`) /
 * present on a same-bucket move (`acl_policy_not_applicable`) — both
 * surface as `validation_failed` with the cause in `issues`. **403** —
 * `doc:write` missing, or a crossing without source administer /
 * destination placement standing. **404** — doc or target collection
 * missing/soft-deleted (cross-workspace targets surface as 404 via
 * tenant scoping; no existence leakage). **409 `slug_collision`** — the
 * moved doc's slug clashes with a live sibling in the target scope.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocMoveInputSchema, DocMoveOutputSchema } from "@editorzero/schemas/doc/move";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_MOVE_ID = CapabilityId("doc.move");

const ParamSchema = DocMoveInputSchema.pick({ doc_id: true });
const BodySchema = DocMoveInputSchema.pick({ new_collection_id: true, acl_policy: true });

export const move = new Hono<ApiEnv>().post(
  "/move/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Re-parent a doc under a different collection (or to the workspace root).",
      responses: {
        200: {
          description: "Moved — post-move metadata.",
          content: jsonContent(DocMoveOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed body/path param, `acl_policy` missing on a cross-boundary move (`acl_transition_policy_required`), or `acl_policy` sent on a same-bucket move (`acl_policy_not_applicable`).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description:
            "Permission denied — caller lacks `doc:write`, or a cross-boundary move without administer authority on the source doc / placement standing in the destination.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Doc or target collection does not exist or is soft-deleted.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "Sibling-slug collision — moved doc's slug is already taken by a live sibling in the target collection scope.",
          content: jsonContent(errEnvelope("slug_collision")),
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
          capability_id: DOC_MOVE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocMoveOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
