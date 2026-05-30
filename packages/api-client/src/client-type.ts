/**
 * `ApiClient` — the materialized typed-RPC client shape (the "materialized
 * precompile" ADR 0028 names as the mitigation for `hc<AppType>` inference
 * cost; ADR 0027 / 0029 point here too).
 *
 * This is the ONE place `AppType` is instantiated through `hc<>` for the
 * purpose of *typing*. Binding the result to an inferred `const` forces tsc
 * to evaluate `Client<>` / `PathToChain` / `UnionToIntersection` exactly
 * once — here — and emit the fully-resolved structure into this package's
 * `.d.ts`. Consumers then import a concrete object type and never re-run
 * that instantiation.
 *
 * The defect this closes: a plain `export type ApiClient =
 * ReturnType<typeof hc<AppType>>` is preserved in declaration emit as the
 * *lazy alias* `ReturnType<typeof hc<AppType>>` (verified — tsc keeps named
 * aliases and conditional types unexpanded). Every consumer of that alias
 * re-instantiates the whole route tree in its own program — the cost ADR
 * 0028 names. A `const`-inferred type is the only form that materialises in
 * emit (a homomorphic mapped type or `extends infer U ? …` does NOT); this
 * is Hono's own `hcWithType` recipe.
 *
 * `Prefix` is pinned to `string` to match what `ReturnType<typeof
 * hc<AppType>>` resolved to (its default), so the runtime factories in
 * `http-client.ts` / `server-client.ts` — which call `hc<AppType>(baseUrl)`
 * — assign to `ApiClient` exactly as before. `baseUrl ""` is never used at
 * runtime; `_client` exists only to carry its inferred type.
 *
 * Coherence check 8 bans the lazy `ReturnType<typeof hc` alias anywhere in
 * `packages/api-client/src/**` so this seam cannot silently regress. If
 * Hono is bumped (pinned — see AGENTS.md gotchas), re-verify the emitted
 * `dist/client-type.d.ts` still materialises (it expands to ~170 KB of
 * spelled-out routes, not a `ReturnType<…>` / `Client<…>` reference).
 */
import type { AppType } from "@editorzero/api-server";
import { hc } from "hono/client";

const _client = hc<AppType, string>("");

export type ApiClient = typeof _client;
