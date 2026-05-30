/**
 * `GET /docs/get/:doc_id` — read a single doc's metadata + block-array
 * projection (first read-path route that exercises `ctx.transact`).
 *
 * **Code-first route shape (ADR 0029).** Mirrors the golden
 * `routes/docs/create`: a self-contained `Hono<ApiEnv>` sub-app built
 * from `factory.createHandlers(...)` over three chained handlers:
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (summary, tags,
 *      per-status response schemas). Documents the contract; does not
 *      feed `hc`.
 *   2. `validator("param", DocGetInputSchema, hook)` — Standard-Schema
 *      path-param validation. The capability input *is* the single-id
 *      object `{ doc_id }`, so the route reuses the capability's own
 *      `DocGetInputSchema` directly as the param validator (PATTERN P2)
 *      rather than re-declaring a wire copy (ADR 0034). The hook
 *      projects a parse failure to the `{ error: "validation_failed" }`
 *      envelope at 400 — the runtime wire shape; this 400, like the
 *      principal middleware's 401, is a cross-cutting middleware return,
 *      intentionally not an `hc` arm (see `lib/errors.ts`).
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches `doc.get`, and returns the dispatcher's output through
 *      `c.json` with 200. The dispatcher *throws* `EditorZeroError`
 *      subclasses; the handler catches and maps them with
 *      `errorResponse(c, err)` to explicit, literal-typed `c.json`
 *      returns — those explicit returns are what `hc<AppType>` reads to
 *      infer the error arm (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` — the
 * `user | agent` union; the handler only reads `workspace_id` (present
 * on both arms) and forwards `principal` to the dispatcher. `dispatch`
 * returns `Promise<unknown>`; rather than *assert* a type with `as`, the
 * handler *parses* that `unknown` through `DocGetOutputSchema.parse` —
 * the honest narrowing, and a runtime guard that the dispatcher output
 * still satisfies the published contract (drift surfaces as a ZodError →
 * 500, not a silent lie).
 *
 * **Reused, not re-declared (ADR 0034).** `DocGetInputSchema` /
 * `DocGetOutputSchema` from `@editorzero/schemas/doc/get` are the single
 * source the capability also consumes. `DocGetInputSchema`'s `doc_id`
 * transform encodes the wire↔branded shape change in one place:
 * `validator("param", DocGetInputSchema)` types the `hc` param as the
 * wire shape (plain UUIDv7 string) while `c.req.valid("param")` hands
 * the handler the branded shape; `resolver` / `describeRoute` generate
 * the OpenAPI param + response from the *input* side, so the spec stays
 * wire-shaped. No wire copy drifts from the capability because there is
 * no copy.
 *
 * **Status codes.**
 *   200 — happy path. Doc exists, blocks projected.
 *   400 — malformed doc_id (not a v7 UUID). Surfaced by the validator
 *         hook before the dispatcher runs.
 *   401 — unauthenticated. Middleware chain at the trunk rejects before
 *         this handler is reached (declaration only).
 *   403 — permission denied (caller lacks `doc:read`).
 *   404 — doc missing or soft-deleted. Capability throws
 *         `NotFoundError`; `errorResponse` maps it to 404.
 *   500 — doc row exists but Y.Doc is empty (inconsistent state).
 *         Capability throws `InternalError`; not a typed client arm —
 *         the trunk's `onError` owns it (so it is not declared here).
 *
 * **Audit + permission + read-path tx live inside the dispatcher.** The
 * handler only dispatches; the permission gate and the `ctx.transact`
 * binding are the dispatcher's.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocGetInputSchema, DocGetOutputSchema } from "@editorzero/schemas/doc/get";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_GET_ID = CapabilityId("doc.get");

export const get = new Hono<ApiEnv>().get(
  "/get/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Read a single doc's metadata and block-array projection.",
      responses: {
        200: {
          description: "Doc metadata + blocks from the live Y.Doc.",
          content: jsonContent(DocGetOutputSchema),
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
          description: "Permission denied — caller lacks `doc:read`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Doc not found (or soft-deleted).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", DocGetInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("param");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: DOC_GET_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocGetOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
