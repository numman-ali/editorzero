/**
 * Capability input schema → citty flag map (ADR 0021 §CLI generator).
 *
 * Each top-level field in the capability's `z.object({...}).strict()`
 * input schema becomes a citty flag of type `string`. The CLI parses
 * the raw strings and hands them back to `runCapability`, which
 * re-validates through the capability's zod schema (belt + braces —
 * the citty parse is shape-shallow, zod is shape-deep + typed).
 *
 * Optionality: a `ZodOptional<T>` field becomes `{ required: false }`;
 * everything else becomes required. We don't try to render richer
 * types (numbers as `--n 42`, booleans as `--flag`) in slice 1 — the
 * agent harness pipes strings in via `--field=value` and zod re-parses.
 * A `z.number()` field still shows as `type: "string"` at the citty
 * level and zod's coerce handles the string-to-number turn. The one
 * explicit boolean lever we might grow is registered-capability flags
 * that genuinely have no value (`--dry-run`) — none of today's doc
 * capabilities use that, so the conversion is deferred until a
 * capability actually needs it.
 *
 * We do NOT derive `--help` text per flag from the zod schema. Zod 4
 * supports `.describe("...")` on any schema; a follow-up slice will
 * thread those strings into the flag `description` here. For now the
 * capability-level `summary` is surfaced at the command level and the
 * flag help is empty.
 */

import type { ArgDef, ArgsDef } from "citty";
import { ZodObject, ZodOptional, type ZodType } from "zod";

/**
 * Produce a citty `ArgsDef` from a capability's input shape. Assumes
 * the caller has validated that the input is a ZodObject (via
 * `deriveHttpBinding`); callers that skip that check get a thrown
 * error here.
 */
export function deriveFlags(inputSchema: ZodType<unknown>): ArgsDef {
  if (!(inputSchema instanceof ZodObject)) {
    throw new Error(
      `deriveFlags: capability input is not a ZodObject (typeName=${inputSchema.constructor.name}).`,
    );
  }
  const shape = inputSchema.shape as Record<string, ZodType<unknown>>;
  const args: Record<string, ArgDef> = {};
  for (const [key, field] of Object.entries(shape)) {
    const required = !(field instanceof ZodOptional);
    args[key] = {
      type: "string",
      required,
    };
  }
  return args;
}
