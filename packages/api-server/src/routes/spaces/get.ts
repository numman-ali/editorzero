/**
 * `GET /spaces/get/:space_id` — read a single space's row.
 *
 * **Code-first route shape (ADR 0029); P2 param variant** — the
 * capability input IS the single-id object `{space_id}`, so the route
 * reuses `SpaceGetInputSchema` directly as the param validator (the
 * `doc.get` pattern). Visibility (reach ∨ administer — see the
 * capability header) and the 404-first trash posture live inside the
 * handler; the route only dispatches and maps thrown
 * `EditorZeroError`s via `errorResponse` to the literal-typed arms
 * `hc<AppType>` reads (ADR 0029 §4).
 *
 * **Response schema — reused, not re-declared (ADR 0034).**
 * `SpaceGetOutputSchema` is `SpaceRowOutputSchema` verbatim — the one
 * space row shape every `space.*` route already serves.
 */

import { CapabilityId } from "@editorzero/ids";
import { SpaceGetInputSchema, SpaceGetOutputSchema } from "@editorzero/schemas/space/get";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const SPACE_GET_ID = CapabilityId("space.get");

export const get = new Hono<ApiEnv>().get(
  "/get/:space_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "Read a single space's row.",
      responses: {
        200: {
          description: "The space row.",
          content: jsonContent(SpaceGetOutputSchema),
        },
        400: {
          description: "Validation error (malformed space_id).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description:
            "Permission denied — caller lacks `workspace:read`, or the space is outside " +
            "their visibility (no baseline reach and no administer standing).",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Space not found (or archived — restore first).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", SpaceGetInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("param");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_GET_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceGetOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
