/**
 * CLI ↔ server route-parity contract (Codex review finding 1).
 *
 * The generator derives `{verb, pathTemplate}` from a capability's
 * id, category, and input shape (see `http-binding.ts`). That
 * convention is cheap but fragile: an irregular plural, a route
 * prefix change, or a read capability that grows a POST endpoint
 * would all compile and silently ship as a runtime 404 without this
 * check.
 *
 * Coherence enforcement: for every capability in `cliRegistry` whose
 * `surfaces` array contains `"cli"`, assert that
 * `deriveHttpBinding(cap)` produces a `{verb, path}` pair that the
 * trunk actually exposes. The trunk's OpenAPI document is the
 * canonical registered-routes surface — `openApiDocument(app)` walks
 * the same trunk (composed via `.route(prefix, subApp)` mounts) the
 * real server serves, so any drift between what the CLI calls and what
 * the server accepts blows up this test.
 *
 * Path normalization:
 *   - OpenAPI emits path params as `{name}`; the CLI derives
 *     `:name`. Both are normalized to the same canonical form
 *     (`:name`) before comparison.
 *   - OpenAPI emits method lowercased; the CLI uses uppercased
 *     verbs. Normalized to uppercase for comparison.
 *
 * The inverse direction is also asserted at the *root* level:
 * every capability with `surfaces.includes("cli")` must have a
 * corresponding subcommand in the root tree built by
 * `createRootCommands(cliRegistry, opts)` — catching the "capability
 * entered the registry but `index.ts` forgot to mount its domain"
 * case (Codex review finding 2).
 */

import { PassThrough } from "node:stream";

import { app, openApiDocument } from "@editorzero/api-server";
import { describe, expect, it, vi } from "vitest";

import type { AuthCredentialStore } from "../credential-store";
import { cliRegistry } from "../registry";
import { deriveHttpBinding } from "./http-binding";
import { createRootCommands } from "./root";

interface RouteKey {
  readonly verb: string;
  readonly path: string;
}

async function normalizedServerRoutes(): Promise<ReadonlySet<string>> {
  const doc = await openApiDocument(app);
  const routes = new Set<string>();
  for (const [rawPath, methods] of Object.entries(doc.paths ?? {})) {
    if (methods === undefined || methods === null) continue;
    const path = rawPath.replace(/\{(\w+)\}/gu, ":$1");
    for (const verb of Object.keys(methods)) {
      routes.add(routeKeyStr({ verb: verb.toUpperCase(), path }));
    }
  }
  return routes;
}

function routeKeyStr(r: RouteKey): string {
  return `${r.verb} ${r.path}`;
}

describe("CLI ↔ server route parity", () => {
  it("every CLI capability's derived binding points at a real registered route on the trunk", async () => {
    const serverRoutes = await normalizedServerRoutes();
    const cliCaps = cliRegistry.list().filter((c) => c.surfaces.includes("cli"));
    expect(cliCaps.length).toBeGreaterThan(0);
    for (const cap of cliCaps) {
      const binding = deriveHttpBinding(cap);
      const expected = routeKeyStr({ verb: binding.verb, path: binding.pathTemplate });
      expect(
        serverRoutes,
        `missing ${expected} — CLI binding for capability "${cap.id}"`,
      ).toContain(expected);
    }
  });

  it("every CLI capability shows up as a subcommand under its domain in the built root", () => {
    const stream = new PassThrough();
    const store: AuthCredentialStore = {
      async read() {
        return { cookie: "session=x" };
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: parity harness reads only; write/clear would never run.
      async write() {},
      // biome-ignore lint/suspicious/noEmptyBlockStatements: same — parity harness reads only.
      async clear() {},
    };
    const roots = createRootCommands(cliRegistry, {
      storeFactory: () => store,
      fetch: vi.fn(),
      stdout: stream,
    });
    const cliCaps = cliRegistry.list().filter((c) => c.surfaces.includes("cli"));
    for (const cap of cliCaps) {
      const [domain, action] = cap.id.split(".");
      if (domain === undefined || action === undefined) {
        throw new Error(`capability "${cap.id}" does not match <domain>.<action>`);
      }
      const domainCmd = roots[domain];
      expect(
        domainCmd,
        `capability "${cap.id}" has no top-level domain "${domain}" in the root tree`,
      ).toBeDefined();
      const subCommands =
        (domainCmd as { subCommands?: Record<string, unknown> } | undefined)?.subCommands ?? {};
      expect(
        subCommands[action],
        `capability "${cap.id}" has no "${action}" subcommand under "${domain}"`,
      ).toBeDefined();
    }
  });

  it("the root tree contains no orphan subcommands (every subcommand has a capability backing it)", () => {
    const stream = new PassThrough();
    const store: AuthCredentialStore = {
      async read() {
        return { cookie: "session=x" };
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: parity harness reads only; write/clear would never run.
      async write() {},
      // biome-ignore lint/suspicious/noEmptyBlockStatements: same — parity harness reads only.
      async clear() {},
    };
    const roots = createRootCommands(cliRegistry, {
      storeFactory: () => store,
      fetch: vi.fn(),
      stdout: stream,
    });
    const capabilityIds = new Set(cliRegistry.list().map((c) => c.id));
    for (const [domain, domainCmd] of Object.entries(roots)) {
      const subCommands =
        (domainCmd as { subCommands?: Record<string, unknown> }).subCommands ?? {};
      for (const action of Object.keys(subCommands)) {
        expect(capabilityIds, `orphan subcommand ez ${domain} ${action}`).toContain(
          `${domain}.${action}`,
        );
      }
    }
  });
});
