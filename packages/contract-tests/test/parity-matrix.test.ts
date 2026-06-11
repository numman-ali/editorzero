/**
 * Cross-surface capability parity matrix (invariant 4; ADR 0009 / 0033 §3 /
 * 0040 H11).
 *
 * "Every capability exists on every type-compatible surface" is only real
 * if an unchecked cell fails the build. Per column:
 *
 *   - **api** — for every capability declaring `"api"`, the registry-derived
 *     HTTP binding (`deriveHttpBinding`, the same SSOT module the CLI
 *     generator calls) must resolve to a route the trunk actually exposes
 *     (`openApiDocument(app)` walks the served Hono tree).
 *   - **cli** — enforced where the surface is generated:
 *     `apps/cli/src/generator/parity.unit.test.ts` asserts the registry ↔
 *     root-command-tree bijection AND that every CLI capability's derived
 *     binding hits a real route. It cannot live here (the generator is
 *     app-internal, not an importable package), and duplicating it would
 *     create a second copy to drift. This file owns the *other* columns.
 *   - **mcp** — for every capability declaring `"mcp"`, the adapter filter
 *     must accept it (`isMcpTool`; catches the humanOnly-but-mcp mistake
 *     the filter's own doc-comment defers to "contract-matrix parity
 *     failure" — this is that failure) and `toToolConfig` must produce a
 *     registrable tool (object input schema, non-empty description).
 *   - **ui** — declared ⇔ proven: the set of capabilities declaring `"ui"`
 *     must equal the set of `proves-capability-cell: <id>` markers carried
 *     by the Playwright specs in `packages/e2e/test/`. The marker is the
 *     bookkeeping bond; the behavioral proof is the marked spec itself,
 *     which runs against the real bundled trunk at pre-push. A capability
 *     claiming `"ui"` with no proving spec — the silent hole H11 closed —
 *     fails here, as does a spec claiming a cell the registry doesn't
 *     declare.
 *
 * The UI ledger below makes the *unbound* cells visible instead of silent:
 * every capability is either ui-declared-and-proven or parked in
 * `UI_PENDING`. Landing a capability's Web UI cell means moving it out of
 * the ledger in the same commit (a stale entry fails). v1-complete on the
 * ui column = an empty ledger (no-MVP-cut: "later" labels build order, not
 * scope).
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, openApiDocument } from "@editorzero/api-server";
import { createDefaultRegistry, deriveHttpBinding } from "@editorzero/capabilities";
import { isMcpTool, toToolConfig } from "@editorzero/mcp-server";
import { describe, expect, it } from "vitest";

const registry = createDefaultRegistry();
const capabilities = registry.list();

/**
 * Capabilities that are type-compatible with the Web UI but whose cell has
 * not landed yet (ADR 0040 H11: `"ui"` is added per-capability as the Web
 * UI grows). Shrink-only ledger: when a capability's UI binding + proving
 * spec land, its entry leaves this list in the same commit.
 */
const UI_PENDING: readonly string[] = [
  "audit.get",
  "audit.list",
  "collection.create",
  "collection.delete",
  "collection.list",
  "collection.move",
  "collection.restore",
  "collection.update",
  "doc.create",
  "doc.delete",
  "doc.get",
  "doc.move",
  "doc.publish",
  "doc.rename",
  "doc.restore",
  "doc.unpublish",
  "doc.update",
  "workspace.get",
  "workspace.member_add",
  "workspace.member_list",
  "workspace.member_remove",
  "workspace.member_update_role",
  "workspace.update",
];

const here = path.dirname(fileURLToPath(import.meta.url));
const E2E_TEST_DIR = path.resolve(here, "../../e2e/test");
const CELL_MARKER = /proves-capability-cell:\s*([a-z][a-z0-9_.]*)/gu;

/** Collect `proves-capability-cell: <id>` markers across the e2e specs. */
function provenUiCells(): ReadonlyMap<string, string> {
  const cells = new Map<string, string>();
  for (const entry of readdirSync(E2E_TEST_DIR)) {
    if (!entry.endsWith(".spec.ts")) continue;
    const source = readFileSync(path.join(E2E_TEST_DIR, entry), "utf8");
    for (const match of source.matchAll(CELL_MARKER)) {
      const id = match[1];
      if (id !== undefined) {
        cells.set(id, entry);
      }
    }
  }
  return cells;
}

describe("capability parity matrix", () => {
  it("the registry is non-trivial (a vacuous matrix can't pass)", () => {
    expect(capabilities.length).toBeGreaterThanOrEqual(24);
  });

  it("api column: every api-declaring capability's derived binding is a real trunk route", async () => {
    const doc = await openApiDocument(app);
    const served = new Set<string>();
    for (const [rawPath, methods] of Object.entries(doc.paths ?? {})) {
      if (methods === undefined || methods === null) continue;
      const normalized = rawPath.replace(/\{(\w+)\}/gu, ":$1");
      for (const verb of Object.keys(methods)) {
        served.add(`${verb.toUpperCase()} ${normalized}`);
      }
    }
    const apiCaps = capabilities.filter((c) => c.surfaces.includes("api"));
    expect(apiCaps.length).toBeGreaterThan(0);
    for (const cap of apiCaps) {
      const binding = deriveHttpBinding(cap);
      const expected = `${binding.verb} ${binding.pathTemplate}`;
      expect(served, `unbound api cell: "${cap.id}" derives ${expected}`).toContain(expected);
    }
  });

  it("mcp column: every mcp-declaring capability registers as a tool", () => {
    const mcpCaps = capabilities.filter((c) => c.surfaces.includes("mcp"));
    expect(mcpCaps.length).toBeGreaterThan(0);
    for (const cap of mcpCaps) {
      // A humanOnly capability declaring "mcp" is a contradictory cell:
      // the adapter filter would drop it, leaving the declaration
      // unchecked-by-construction.
      expect(isMcpTool(cap), `"${cap.id}" declares "mcp" but isMcpTool rejects it`).toBe(true);
      const config = toToolConfig(cap); // throws NonObjectInputSchemaError on a non-object input
      expect(config.description, `"${cap.id}" has an empty tool description`).not.toBe("");
      expect(config.inputSchema).toBeDefined();
    }
  });

  it("ui column: every ui-declaring capability has a proving e2e spec, and vice versa", () => {
    const declared = new Set(
      capabilities.filter((c) => c.surfaces.includes("ui")).map((c) => c.id),
    );
    const proven = provenUiCells();
    expect(declared.size).toBeGreaterThan(0);

    const unproven = [...declared].filter((id) => !proven.has(id)).sort();
    expect(
      unproven,
      `capabilities declare "ui" without a proving spec marker (add "proves-capability-cell: <id>" to the packages/e2e spec that exercises the cell)`,
    ).toEqual([]);

    const overclaimed = [...proven.entries()]
      .filter(([id]) => !declared.has(id))
      .map(([id, file]) => `${id} (claimed by ${file})`)
      .sort();
    expect(
      overclaimed,
      `e2e specs claim cells the registry does not declare as "ui" — either declare the surface on the capability or drop the marker`,
    ).toEqual([]);
  });

  it("ui ledger: every capability is either ui-bound or explicitly pending — no silent cells", () => {
    const allIds = new Set(capabilities.map((c) => c.id));
    const declared = new Set(
      capabilities.filter((c) => c.surfaces.includes("ui")).map((c) => c.id),
    );
    const pending = new Set(UI_PENDING);

    const unknownPending = [...pending].filter((id) => !allIds.has(id)).sort();
    expect(unknownPending, "UI_PENDING names capabilities that don't exist").toEqual([]);

    const stale = [...pending].filter((id) => declared.has(id)).sort();
    expect(
      stale,
      'stale UI_PENDING entries — these capabilities now declare "ui"; remove them from the ledger',
    ).toEqual([]);

    const silent = [...allIds].filter((id) => !declared.has(id) && !pending.has(id)).sort();
    expect(
      silent,
      'capabilities with no "ui" declaration and no UI_PENDING entry — park them in the ledger or land their cell',
    ).toEqual([]);
  });
});
