/**
 * `POST /workspaces/update` — mutate the caller's workspace metadata
 * (invariant 4). Code-first shape (ADR 0029); see `docs/create.ts` for
 * the golden walkthrough of the `factory.createHandlers(describeRoute,
 * validator, handler)` chain and why the handler narrows the dispatcher's
 * `unknown` output via `.parse` rather than an `as` cast.
 *
 * Metadata-only mutation. Updates `name`, `trash_retention_days`, or
 * `settings` (any subset — at least one required). Scope
 * `workspace:admin`; members / guests get 403.
 *
 * Path follows the repo-wide `<plural>/<action>` convention; the `docs`
 * domain mounts at `/docs`, this one at `/workspaces`, so the external
 * path is `/workspaces/update` and `hc<AppType>` reconstructs
 * `client.workspaces.update.$post`.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `WorkspaceUpdateInputSchema` / `WorkspaceUpdateOutputSchema` from
 * `@editorzero/schemas/workspace/update` are the single source the
 * capability also consumes. The input schema's `.strict()` rejects a
 * stray `{ slug: ... }` (slug is bootstrap-derived, not mutable here),
 * and its `.refine(at-least-one)` rejects the no-op `{}` patch — both
 * surface as the validator's 400 before the handler runs. No wire copy
 * drifts from the capability because there is no copy.
 *
 * **Status — 200 OK** (update, not create). Echoes the post-state of the
 * mutable fields plus `workspace_id` so callers don't need a follow-up
 * `GET /workspaces/get`.
 *
 * **Audit + permission + write-path tx live inside the dispatcher.** The
 * handler only dispatches; the permission gate and the single write-path
 * SQL tx (the audit row lands in the same tx) are the dispatcher's. The
 * only error arm the handler maps from a *thrown* `EditorZeroError` is
 * 404 (`NotFoundError` — workspace soft-deleted or bootstrap gap); 401 is
 * the principal middleware's, 403 the gate's, 400 the validator's.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  WorkspaceUpdateInputSchema,
  WorkspaceUpdateOutputSchema,
} from "@editorzero/schemas/workspace/update";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const WORKSPACE_UPDATE_ID = CapabilityId("workspace.update");

export const update = new Hono<ApiEnv>().post(
  "/update",
  ...factory.createHandlers(
    describeRoute({
      tags: ["workspaces"],
      summary: "Update the caller's workspace (name, trash_retention_days, settings).",
      responses: {
        200: {
          description: "Updated — post-patch metadata.",
          content: jsonContent(WorkspaceUpdateOutputSchema),
        },
        400: {
          description:
            "Validation error — empty patch, invalid retention bound, or unknown body key (e.g. slug).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `workspace:admin`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Workspace is soft-deleted or missing (bootstrap gap).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("json", WorkspaceUpdateInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("json");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: WORKSPACE_UPDATE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(WorkspaceUpdateOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
