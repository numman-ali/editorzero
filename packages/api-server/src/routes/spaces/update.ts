/**
 * `POST /spaces/update/:space_id` — patch a live space's mutable subset.
 *
 * Code-first route (ADR 0029 / 0034), pattern P3 (path param + JSON
 * body merged into one capability input — the `docs/rename.ts` shape):
 * `SpaceUpdateParamSchema` / `SpaceUpdateBodySchema` are derived in the
 * schema module from the SAME base object the capability parses, so the
 * body half keeps `.strict()` AND the at-least-one-patch-field refine.
 *
 * **Status codes.**
 *   200 — patched; echoes the full post-patch space row.
 *   400 — malformed space_id, empty patch, unknown key, or bad slug.
 *   401 — unauthenticated.
 *   403 — permission denied — caller lacks administer-tier on the
 *         space (personal: owner only; team: space owner-tier or
 *         workspace owner/admin backstop).
 *   404 — space missing or soft-deleted (restore first).
 *   409 — slug collision, or the space was archived concurrently.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  SpaceUpdateBodySchema,
  SpaceUpdateOutputSchema,
  SpaceUpdateParamSchema,
} from "@editorzero/schemas/space/update";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const SPACE_UPDATE_ID = CapabilityId("space.update");

export const update = new Hono<ApiEnv>().post(
  "/update/:space_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "Patch a space's name/slug/type/baseline; personal spaces pin type + baseline.",
      responses: {
        200: {
          description: "Patched — echoes the full post-patch space row.",
          content: jsonContent(SpaceUpdateOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed space_id, empty patch, unknown key, bad slug, or a personal-space type/baseline patch.",
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
          description: "Space not found (or soft-deleted — restore first).",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description: "Slug collision with a live space, or concurrent archive.",
          content: jsonContent(errEnvelope("conflict")),
        },
      },
    }),
    validator("param", SpaceUpdateParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", SpaceUpdateBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_UPDATE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceUpdateOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
