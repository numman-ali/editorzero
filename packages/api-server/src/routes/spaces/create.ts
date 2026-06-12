/**
 * `POST /spaces/create` — mint a TEAM space.
 *
 * Code-first route (ADR 0029 / 0034) mirroring `permissions/grant.ts`:
 * one `validator("json", SpaceCreateInputSchema)` reusing the capability
 * schema verbatim (SSOT — no restated wire copy), thin dispatcher call,
 * output re-parsed through the capability's output schema (no `as`).
 *
 * **Status codes.**
 *   200 — created; echoes the full space row.
 *   400 — malformed body (empty name, unknown key, bad space_type).
 *   401 — unauthenticated.
 *   403 — permission denied: `space.create` requires `workspace:admin`
 *         (creation shapes the org; the member-wide `space:manage`
 *         family starts at `space.update`).
 *   409 — slug collision with a live space.
 */

import { CapabilityId } from "@editorzero/ids";
import { SpaceCreateInputSchema, SpaceCreateOutputSchema } from "@editorzero/schemas/space/create";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const SPACE_CREATE_ID = CapabilityId("space.create");

export const create = new Hono<ApiEnv>().post(
  "/create",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "Create a TEAM space (membership boundary); personal spaces are signup-seeded.",
      responses: {
        200: {
          description: "Created — echoes the full space row (kind=team, owner_user_id=null).",
          content: jsonContent(SpaceCreateOutputSchema),
        },
        400: {
          description: "Validation error — empty name, unknown key, or bad space_type.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — `space.create` requires `workspace:admin`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        409: {
          description: "Slug collision — a live space already uses the derived slug.",
          content: jsonContent(errEnvelope("conflict")),
        },
      },
    }),
    validator("json", SpaceCreateInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_CREATE_ID,
          input: c.req.valid("json"),
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceCreateOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
