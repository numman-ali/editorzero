/**
 * Capability input schema → citty flag map (ADR 0021 §CLI generator).
 *
 * Each top-level field in the capability's `z.object({...}).strict()`
 * input schema becomes a citty flag of type `string`. The CLI parses
 * the raw strings and hands them back to `runCapability`, which
 * re-validates through the capability's zod schema (belt + braces —
 * the citty parse is shape-shallow, zod is shape-deep + typed).
 *
 * Optionality: a field the caller may OMIT becomes `{ required: false }`.
 * Two wrappers grant that: `ZodOptional<T>` (explicit) and `ZodDefault<T>`
 * (a default fills the gap — e.g. `agent.token_mint`'s `expires_at`
 * defaults to `null`, so forcing `--expires_at` would be wrong). A bare
 * `ZodNullable<T>` stays required: `null` is an allowed VALUE, not license
 * to drop the flag. Everything else is required. We don't try to render
 * richer
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
import {
  ZodArray,
  ZodDefault,
  ZodDiscriminatedUnion,
  ZodNullable,
  ZodObject,
  ZodOptional,
  ZodRecord,
  ZodTuple,
  type ZodType,
} from "zod";

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
    // Omittable ⇔ ZodOptional (explicit) or ZodDefault (a default backfills
    // the missing flag). A bare ZodNullable is NOT omittable — `null` is a
    // value the caller must still pass.
    const required = !(field instanceof ZodOptional || field instanceof ZodDefault);
    args[key] = {
      type: "string",
      required,
    };
  }
  return args;
}

/**
 * The top-level input fields whose values are STRUCTURED (object /
 * tagged-union / array / record / tuple after unwrapping optional +
 * nullable) and therefore ride a flag as a JSON document — e.g.
 * `collection.move`'s `destination: { kind: "space_root", space_id }`.
 *
 * `runCapability` JSON-parses exactly these flags before the zod parse
 * (a malformed document is a typed CLI validation error, not a crash).
 * The decode is SURFACE plumbing, not schema tolerance: the shared
 * schema stays object-shaped (one definition for HTTP body, MCP, and
 * the OpenAPI document), and the CLI decodes its string transport the
 * same way Hono decodes the HTTP body before the validator.
 *
 * Detection is by zod CLASS, deliberately conservative: a transform
 * pipeline whose input is a plain string (branded ids, coerced numbers)
 * is NOT structured — strings pass through verbatim. Plain `ZodUnion`
 * is excluded until a capability actually ships one (a union of string
 * literals must NOT be JSON-parsed; the discriminated form is
 * unambiguous because every arm is an object).
 */
export function deriveJsonFlagKeys(inputSchema: ZodType<unknown>): ReadonlySet<string> {
  if (!(inputSchema instanceof ZodObject)) {
    throw new Error(
      `deriveJsonFlagKeys: capability input is not a ZodObject (typeName=${inputSchema.constructor.name}).`,
    );
  }
  const keys = new Set<string>();
  for (const [key, field] of Object.entries(inputSchema.shape)) {
    let inner: unknown = field;
    while (inner instanceof ZodOptional || inner instanceof ZodNullable) {
      inner = inner.unwrap();
    }
    if (
      inner instanceof ZodObject ||
      inner instanceof ZodDiscriminatedUnion ||
      inner instanceof ZodArray ||
      inner instanceof ZodRecord ||
      inner instanceof ZodTuple
    ) {
      keys.add(key);
    }
  }
  return keys;
}
