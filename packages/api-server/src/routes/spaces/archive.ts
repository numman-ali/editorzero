/**
 * `POST /spaces/archive/:space_id` — soft-delete (archive) a space.
 *
 * Code-first route (ADR 0029 / 0034) mirroring `collections/delete.ts`:
 * param-only input via the capability schema (SSOT), thin dispatcher
 * call, output re-parsed through the capability's output schema.
 *
 * **Status codes.**
 *   200 — archived; echoes `{space_id, deleted_at}`.
 *   400 — malformed space_id.
 *   401 — unauthenticated.
 *   403 — permission denied — caller lacks administer-tier on the
 *         space (personal: owner only; admins excluded).
 *   404 — space missing or already archived.
 *   409 — live collections, docs, or members remain (empty the space
 *         first; the error body's code is `has_live_descendants`).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  SpaceArchiveInputSchema,
  SpaceArchiveOutputSchema,
} from "@editorzero/schemas/space/archive";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const SPACE_ARCHIVE_ID = CapabilityId("space.archive");

export const archive = new Hono<ApiEnv>().post(
  "/archive/:space_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "Archive (soft-delete) a space; refuses while live content or members remain.",
      responses: {
        200: {
          description: "Archived — echoes the id + handler clock.",
          content: jsonContent(SpaceArchiveOutputSchema),
        },
        400: {
          description: "Validation error — malformed space_id.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks administer-tier on the space.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Space not found (or already archived).",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "Live collections, docs, or members remain — empty the space first (has_live_descendants).",
          content: jsonContent(errEnvelope("has_live_descendants")),
        },
      },
    }),
    validator("param", SpaceArchiveInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_ARCHIVE_ID,
          input: c.req.valid("param"),
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceArchiveOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
