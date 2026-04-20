/**
 * `toToolConfig` — projects a registry `Capability` into the config
 * object `McpServer.registerTool(name, config, cb)` expects (ADR 0026
 * commitment 3).
 *
 * The MCP SDK 1.x `inputSchema` field accepts a zod **raw shape** —
 * `{ key: z.ZodType }` — not a `ZodObject`. Every capability in this
 * tree declares input as `z.object({...}).strict()` (see kernel.ts
 * `Capability.input: ZodType<unknown>` — the runtime value is always a
 * `ZodObject`, the type is widened to `ZodType<unknown>` so the
 * registry can hold heterogeneous caps in one list). We narrow with
 * `instanceof ZodObject` to extract `.shape`; a capability whose input
 * is not a ZodObject is a registration bug (MCP tools take named
 * arguments, period — no top-level unions or primitives).
 *
 * `outputSchema` is **not** populated in slice 1. Populating it would
 * promise the MCP client structured output keyed by the capability's
 * output shape — but some capability outputs carry branded IDs or
 * transformed types that don't serialise uniformly to the wire form
 * the contract tests assert for the REST surface. Holding output as
 * plain JSON in `content[0].text` matches how typical MCP tools return
 * values and keeps the REST + MCP wire contracts aligned for slice 1.
 * ADR 0026 § Deferred lists `outputSchema` opt-in as a follow-on.
 */

import type { AnyCapability } from "@editorzero/capabilities";
import type { ZodRawShape } from "zod";
import { ZodObject } from "zod";

export interface McpToolConfig {
  readonly description: string;
  readonly inputSchema: ZodRawShape;
}

export class NonObjectInputSchemaError extends Error {
  override readonly name = "NonObjectInputSchemaError";
  readonly capability_id: string;

  constructor(capability_id: string) {
    super(
      `Capability "${capability_id}" cannot be exposed as an MCP tool: input schema ` +
        `must be a ZodObject. MCP tools take named arguments — top-level unions, ` +
        `primitives, and arrays are not supported by the registration shape.`,
    );
    this.capability_id = capability_id;
  }
}

export function toToolConfig(cap: AnyCapability): McpToolConfig {
  if (!(cap.input instanceof ZodObject)) {
    throw new NonObjectInputSchemaError(cap.id);
  }
  return {
    description: cap.summary,
    inputSchema: cap.input.shape as ZodRawShape,
  };
}
