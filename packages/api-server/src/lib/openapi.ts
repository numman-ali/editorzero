/**
 * api-server's OpenAPI + validation construction kit — the single module
 * that imports `hono-openapi` (ADR 0029 §7). Every capability route is
 * built from these primitives; nothing else in the package imports
 * `hono-openapi` directly, so upgrading or swapping the code-first
 * OpenAPI substrate is a one-file change.
 *
 * ADR 0029 §7 names an `api-openapi` *package* as the fence. api-server
 * is the sole consumer of `hono-openapi`, so a module-level fence is the
 * right-sized realisation — a dedicated package would add workspace +
 * tsconfig-reference ceremony for a one-consumer dependency with no
 * second importer to justify it. Recorded as a §7 amendment; promote to
 * a package only when a second package needs these primitives.
 *
 * What lives here:
 *  - `factory` — one `createFactory<ApiEnv>()` shared by every route, so
 *    `factory.createHandlers(describeRoute, validator, handler)` types
 *    each handler in the chain against the trunk's single `ApiEnv`
 *    (`env.ts`) and preserves `hc<AppType>` input+output inference
 *    through `.route()` composition (ADR 0029 §2).
 *  - re-exports of the `hono-openapi` primitives routes use directly:
 *    `describeRoute` (OpenAPI-metadata middleware), `validator`
 *    (Standard-Schema request validation — In=InferInput / Out=
 *    InferOutput), `resolver` (wraps a schema for a `describeRoute`
 *    response / requestBody), `generateSpecs` (emits the OpenAPI
 *    document for the snapshot test + the served spec),
 *    `openAPIRouteHandler` (serves it).
 *  - `jsonContent` / `errEnvelope` — keep `describeRoute` response
 *    declarations DRY across the ~26 capability routes.
 */

import type { Env, Hono, Schema } from "hono";
import { createFactory } from "hono/factory";
import type { ResolverReturnType } from "hono-openapi";
import {
  describeRoute,
  generateSpecs,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { z } from "zod";

import type { ApiEnv } from "../env";

export { describeRoute, generateSpecs, openAPIRouteHandler, resolver, validator };

/**
 * Generate the trunk's OpenAPI 3.1 document from the code-first route
 * metadata. This is the **one** entry point for the OpenAPI document —
 * the served spec (when wired), the snapshot/contract tests, and the
 * CLI↔server route-parity check all derive it here, so the `info` /
 * `openapi` envelope is declared in a single place (ADR 0029). Keeping
 * it behind this helper is also what holds the `hono-openapi` fence
 * (§7): external consumers (the CLI parity test) import this from
 * `@editorzero/api-server`, never `hono-openapi` directly.
 *
 * Async because `resolver` schema conversion is async in hono-openapi
 * 1.3.0. Generic over the app's `Env` / `Schema` / base path so the
 * fully-merged trunk type (`AppType`) passes without widening.
 */
export function openApiDocument<E extends Env, S extends Schema, BasePath extends string>(
  app: Hono<E, S, BasePath>,
) {
  return generateSpecs(app, {
    documentation: {
      openapi: "3.1.0",
      info: { title: "editorzero api", version: "0.0.0" },
    },
  });
}

/**
 * The one factory shared by every route module. A single
 * `createFactory<ApiEnv>()` binding means every `createHandlers(...)`
 * chain is typed against the same env — no per-module env fragmentation
 * (the failure mode `env.ts` documents).
 */
export const factory = createFactory<ApiEnv>();

/**
 * `describeRoute` response / requestBody content helper:
 * `content: jsonContent(Schema)` → `{ "application/json": { schema: resolver(Schema) } }`.
 * Schemas inline into the generated OpenAPI (no `$ref` component reuse —
 * `resolver` + `generateSpecs` do not extract named components from
 * `.meta({ id })` in hono-openapi 1.3.0; ADR 0029 §6). The inlined spec
 * is accurate; the snapshot test guards fidelity.
 */
export function jsonContent(schema: z.ZodType): {
  "application/json": { schema: ResolverReturnType };
} {
  // `resolver`'s return embeds `StandardSchemaV1.Result`, which TS cannot
  // name at this exported-helper boundary (TS4058 under declaration emit).
  // `ResolverReturnType` is hono-openapi's own named alias for it — annotate
  // explicitly so the emitted `.d.ts` references the alias, not the leak.
  return { "application/json": { schema: resolver(schema) } };
}

/**
 * A single `{ error: <code> }` wire-envelope schema (ADR 0033). Used in
 * `describeRoute` responses (via `jsonContent`) to document an error
 * arm; `errorResponse` in `./errors` emits the same literal at runtime.
 */
export function errEnvelope<C extends string>(code: C) {
  return z.object({ error: z.literal(code) });
}

/**
 * Two `{ error: <code> }` envelopes that share ONE HTTP status — the
 * union documents both literals on the same `describeRoute` response
 * (OpenAPI `anyOf`). Needed where a route can 409 with distinct codes
 * (e.g. `conflict` race vs `grant_lifecycle_conflict` lane routing);
 * runtime still emits exactly one literal per response via
 * `errorResponse`.
 */
export function errEnvelopeOneOf<A extends string, B extends string>(a: A, b: B) {
  return z.union([errEnvelope(a), errEnvelope(b)]);
}
