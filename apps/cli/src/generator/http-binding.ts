/**
 * Capability → HTTP binding derivation (ADR 0021, invariant 4).
 *
 * The registry does not record HTTP verb or path — those live on the
 * route files in `packages/api-server/src/routes/<domain>/<action>.ts`.
 * But the convention the server follows is tight enough that the CLI
 * can derive the binding from the capability alone:
 *
 *   - `id = "<domain>.<action>"` (e.g. `"doc.list"`, `"doc.get"`).
 *   - Plural-domain prefix: `<domain>s` (naïve: adds `s`). Irregular
 *     plurals will break this rule; the parity contract test in the
 *     next slice catches the mismatch at commit time, and the
 *     capability can grow an explicit `http` binding if the
 *     convention stops being sufficient.
 *   - Verb: `"read"` → GET, `"mutation"` → POST.
 *   - Path param: if the input has a `<domain>_id` field, the path
 *     is `/<plural>/<action>/:<domain>_id` and the field is a path
 *     param. Otherwise the input decomposes into either a query
 *     string (GET) or a JSON body (POST), each remaining input field
 *     mapped by its key.
 *
 * Coherence with the server:
 *   - `GET /docs/list`                         (doc.list;  empty input)
 *   - `POST /docs/create`                      (doc.create; body={title})
 *   - `GET /docs/get/:doc_id`                  (doc.get;   param={doc_id})
 *   - `POST /docs/publish/:doc_id`             (doc.publish)
 *   - `POST /docs/unpublish/:doc_id`           (doc.unpublish)
 *   - `POST /docs/delete/:doc_id`              (doc.delete)
 *   - `POST /docs/restore/:doc_id`             (doc.restore)
 *   - `POST /docs/rename/:doc_id`              (doc.rename; body={title})
 *
 * All eight derive correctly from the rules above. The `deriveHttpBinding`
 * tests assert that; the parity contract test (commit 3) closes the
 * loop against the real registered routes.
 */

import type { AnyCapability } from "@editorzero/capabilities";
import { ZodObject, type ZodType } from "zod";

export interface HttpBinding {
  readonly verb: "GET" | "POST";
  /**
   * Template path with any path-param segment as `:<name>`. The runtime
   * substitutes the concrete value from the caller's input before the
   * request lands. Example: `"/docs/get/:doc_id"`.
   */
  readonly pathTemplate: string;
  /** The input field name that maps to the path param, or null if none. */
  readonly paramName: string | null;
  /**
   * Input fields that map to query-string keys (GET) or JSON body keys
   * (POST). Does not include the path-param field. Sorted lexicographically
   * for deterministic output in tests + OpenAPI.
   */
  readonly bodyOrQueryKeys: readonly string[];
}

export function deriveHttpBinding(capability: AnyCapability): HttpBinding {
  const [domain, action, ...rest] = capability.id.split(".");
  if (domain === undefined || action === undefined || rest.length !== 0) {
    throw new Error(
      `deriveHttpBinding: capability id "${capability.id}" does not match the "<domain>.<action>" shape.`,
    );
  }
  const plural = `${domain}s`;
  const verb: "GET" | "POST" = capability.category === "read" ? "GET" : "POST";
  const paramName = `${domain}_id`;
  const shape = getObjectShape(capability.input);
  const keys = Object.keys(shape).sort();
  const hasParam = keys.includes(paramName);
  const pathTemplate = hasParam ? `/${plural}/${action}/:${paramName}` : `/${plural}/${action}`;
  const bodyOrQueryKeys = keys.filter((k) => k !== (hasParam ? paramName : null));
  return {
    verb,
    pathTemplate,
    paramName: hasParam ? paramName : null,
    bodyOrQueryKeys,
  };
}

/**
 * Expand a path template + path-param value into a concrete path.
 * Safe for `paramName === null` (returns the template unchanged).
 * Throws if a `:name` placeholder exists but no value is supplied —
 * that's a programming error, not a user error.
 */
export function expandPathTemplate(
  pathTemplate: string,
  paramName: string | null,
  paramValue: string | null,
): string {
  if (paramName === null) return pathTemplate;
  if (paramValue === null || paramValue === "") {
    throw new Error(
      `expandPathTemplate: path template "${pathTemplate}" needs a value for :${paramName}, got none.`,
    );
  }
  return pathTemplate.replace(`:${paramName}`, encodeURIComponent(paramValue));
}

/**
 * Narrow a capability's `input` schema to its object shape. Every
 * capability we ship today uses `z.object({...}).strict()` at the top
 * level (enforced by the capability kernel convention). If a future
 * capability wraps its input in a ZodEffects / ZodUnion, the generator
 * needs to grow — but it should grow explicitly, not silently. The
 * throw path here fires that signal. Zod 4's `ZodObject.shape` is a
 * public property (typed `Record<string, ZodType>`), and `instanceof
 * ZodObject` is the public narrowing hook.
 */
function getObjectShape(schema: ZodType<unknown>): Record<string, ZodType<unknown>> {
  if (schema instanceof ZodObject) {
    return schema.shape as Record<string, ZodType<unknown>>;
  }
  throw new Error(
    `deriveHttpBinding: capability input is not a ZodObject (typeName=${schema.constructor.name}); ` +
      "the registry-driven CLI generator currently supports only top-level object schemas.",
  );
}
