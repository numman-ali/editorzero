/**
 * `POST /spaces/restore/:space_id` — revive a soft-deleted space.
 *
 * Code-first route (ADR 0029 / 0034) mirroring
 * `collections/restore.ts`: param-only input via the capability schema
 * (SSOT), thin dispatcher call, output re-parsed through the
 * capability's output schema.
 *
 * **Status codes.**
 *   200 — restored; echoes `{space_id}`.
 *   400 — malformed space_id.
 *   401 — unauthenticated.
 *   403 — permission denied — the dead-row restore ladder (personal:
 *         owner only; team: surviving owner grant or admin backstop).
 *   404 — space missing or already live.
 *   409 — a live space claimed the slug meanwhile (slug_collision), or
 *         the owner already has a live personal space (conflict).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  SpaceRestoreInputSchema,
  SpaceRestoreOutputSchema,
} from "@editorzero/schemas/space/restore";
import { Hono } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const SPACE_RESTORE_ID = CapabilityId("space.restore");

export const restore = new Hono<ApiEnv>().post(
  "/restore/:space_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "Restore a soft-deleted space; refuses on slug collision or a live personal twin.",
      responses: {
        200: {
          description: "Restored — echoes the id.",
          content: jsonContent(SpaceRestoreOutputSchema),
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
          description: "Permission denied — caller lacks restore authority on the trashed space.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Space not found (or already live).",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "A live space claimed the slug (slug_collision), or the owner already has a " +
            "live personal space (conflict). The `error` code discriminates.",
          content: jsonContent(z.object({ error: z.enum(["slug_collision", "conflict"]) })),
        },
      },
    }),
    validator("param", SpaceRestoreInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_RESTORE_ID,
          input: c.req.valid("param"),
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceRestoreOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
