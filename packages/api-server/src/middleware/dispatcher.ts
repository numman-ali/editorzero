/**
 * `createDispatcherMiddleware` — attach a process-scoped
 * `Dispatcher` to `c.var` (ADR 0021 composition).
 *
 * The dispatcher itself is stateless given immutable deps
 * (registry, gate, auditWriter, driver-bound runners). Constructing
 * one per request would be wasteful; the trunk builds one at
 * composition time and this middleware propagates it to
 * `c.var.dispatcher` so route handlers can invoke capabilities
 * without importing the composition root.
 *
 * **Why on context rather than module-scope.** Keeping the
 * dispatcher on `c.var` keeps route handlers independent of the
 * composition root — per-route tests can swap a fixture dispatcher
 * in via their own `createDispatcherMiddleware({ dispatcher:
 * stubDispatcher })` without rewiring the handler's imports.
 *
 * **Must run after the principal middleware.** Capability
 * dispatch requires a `Principal`; the dispatcher middleware does
 * not read `c.var.principal`, so order is not a hard failure, but
 * composing the middleware chain as `[principal, dispatcher,
 * ...routeMw]` is the expected shape. See `src/app.ts`.
 */

import type { Dispatcher } from "@editorzero/dispatcher";
import type { MiddlewareHandler } from "hono";

import type { ApiEnv } from "../env";

export interface DispatcherMiddlewareOptions {
  readonly dispatcher: Dispatcher;
}

export function createDispatcherMiddleware(
  options: DispatcherMiddlewareOptions,
): MiddlewareHandler<ApiEnv> {
  const { dispatcher } = options;
  return async (c, next) => {
    c.set("dispatcher", dispatcher);
    await next();
  };
}
