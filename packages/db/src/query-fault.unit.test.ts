/**
 * Tests for `createQueryFaultPlugin` + `describeQueryNode`.
 *
 * The plugin's correctness rests on three behaviours:
 *  1. `transformQuery` invokes the callback with a `QueryTag` derived
 *     from `args.node` and returns the query node unchanged when the
 *     callback doesn't throw.
 *  2. When the callback throws, `transformQuery` propagates the throw
 *     — the crash-fuzz property test relies on this to abort the
 *     enclosing SQL tx.
 *  3. `describeQueryNode` produces the right `{kind, table, event}` for
 *     each query shape the write path emits (INSERT / UPDATE / SELECT
 *     / DELETE); the property test's baseline uses these tags to
 *     prove specific writes (e.g., INSERT `audit_events`, INSERT
 *     `outbox(audit.appended)` distinguished from `outbox(doc.updated)`)
 *     ran inside the faulted tx rather than outside it.
 *
 * The actual write-path atomicity proof lives in
 * `packages/dispatcher/prop/writepath-atomicity.test.ts`; these
 * unit tests just pin the plugin's contract locally so a regression
 * here surfaces inside `@editorzero/db`'s test run.
 */

import { describe, expect, it } from "vitest";

import { createQueryFaultPlugin, describeQueryNode, type QueryTag } from "./query-fault";

// Minimal mock builders. Rather than go through Kysely's query
// builders (which would drag in a driver + dialect), we construct the
// AST nodes Kysely would produce. The shapes below match
// `InsertQueryNode` / `SelectQueryNode` / `UpdateQueryNode` /
// `DeleteQueryNode` in the pinned Kysely version (see
// node_modules/kysely@0.28.x/dist/esm/operation-node/*.d.ts).
function tableNode(name: string) {
  return {
    kind: "TableNode" as const,
    table: {
      kind: "SchemableIdentifierNode" as const,
      identifier: { kind: "IdentifierNode" as const, name },
    },
  };
}

function columnNode(name: string) {
  return {
    kind: "ColumnNode" as const,
    column: { kind: "IdentifierNode" as const, name },
  };
}

function insertNode(table: string): { kind: "InsertQueryNode" } {
  return { kind: "InsertQueryNode", into: tableNode(table) } as never;
}

function insertNodeWithEvent(
  table: string,
  event: string,
  { wrap = "primitive" }: { wrap?: "primitive" | "value" } = {},
): { kind: "InsertQueryNode" } {
  const columns = [columnNode("id"), columnNode("event"), columnNode("payload")];
  const firstRow =
    wrap === "primitive"
      ? {
          kind: "PrimitiveValueListNode" as const,
          values: ["01", event, "{}"],
        }
      : {
          kind: "ValueListNode" as const,
          values: [
            { kind: "ValueNode" as const, value: "01" },
            { kind: "ValueNode" as const, value: event },
            { kind: "ValueNode" as const, value: "{}" },
          ],
        };
  return {
    kind: "InsertQueryNode",
    into: tableNode(table),
    columns,
    values: { kind: "ValuesNode" as const, values: [firstRow] },
  } as never;
}

function updateNode(table: string): { kind: "UpdateQueryNode" } {
  return { kind: "UpdateQueryNode", table: tableNode(table) } as never;
}

function selectNode(table: string): { kind: "SelectQueryNode" } {
  return {
    kind: "SelectQueryNode",
    from: { kind: "FromNode", froms: [tableNode(table)] },
  } as never;
}

function selectNodeWithJoin(table: string): { kind: "SelectQueryNode" } {
  return {
    kind: "SelectQueryNode",
    from: { kind: "FromNode", froms: [tableNode(table)] },
    joins: [{ kind: "JoinNode" }],
  } as never;
}

function selectNodeMultiFrom(...tables: string[]): { kind: "SelectQueryNode" } {
  return {
    kind: "SelectQueryNode",
    from: { kind: "FromNode", froms: tables.map(tableNode) },
  } as never;
}

function deleteNode(table: string): { kind: "DeleteQueryNode" } {
  return {
    kind: "DeleteQueryNode",
    from: { kind: "FromNode", froms: [tableNode(table)] },
  } as never;
}

describe("createQueryFaultPlugin", () => {
  it("invokes the callback with a QueryTag and returns args.node unchanged on transformQuery", () => {
    const received: QueryTag[] = [];
    const plugin = createQueryFaultPlugin((tag) => {
      received.push(tag);
    });
    const node = insertNode("audit_events") as never;
    const result = plugin.transformQuery({ node, queryId: { queryId: "q1" } });
    expect(result).toBe(node);
    expect(received).toEqual([{ kind: "InsertQueryNode", table: "audit_events", event: null }]);
  });

  it("propagates the callback's throw", () => {
    const plugin = createQueryFaultPlugin(() => {
      throw new Error("fault");
    });
    expect(() =>
      plugin.transformQuery({
        node: insertNode("audit_events") as never,
        queryId: { queryId: "q1" },
      }),
    ).toThrow("fault");
  });

  it("transformResult is a pass-through", async () => {
    let calls = 0;
    const plugin = createQueryFaultPlugin(() => {
      calls += 1;
    });
    const shaped = { rows: [{ a: 1 }] };
    const result = await plugin.transformResult({
      result: shaped,
      queryId: { queryId: "q1" },
    });
    // `transformResult` must not invoke the callback — only queries
    // mutate the fault counter; results are observational.
    expect(calls).toBe(0);
    expect(result).toBe(shaped);
  });
});

describe("describeQueryNode", () => {
  it("extracts the target table from InsertQueryNode", () => {
    expect(describeQueryNode(insertNode("audit_events") as never)).toEqual({
      kind: "InsertQueryNode",
      table: "audit_events",
      event: null,
    });
  });

  it("extracts the outbox event literal from a PrimitiveValueListNode INSERT", () => {
    expect(describeQueryNode(insertNodeWithEvent("outbox", "doc.updated") as never)).toEqual({
      kind: "InsertQueryNode",
      table: "outbox",
      event: "doc.updated",
    });
  });

  it("extracts the outbox event literal from a ValueListNode INSERT", () => {
    expect(
      describeQueryNode(
        insertNodeWithEvent("outbox", "audit.appended", { wrap: "value" }) as never,
      ),
    ).toEqual({
      kind: "InsertQueryNode",
      table: "outbox",
      event: "audit.appended",
    });
  });

  it("returns event=null when outbox INSERT has no event column", () => {
    const bareInsert = {
      kind: "InsertQueryNode",
      into: tableNode("outbox"),
      columns: [columnNode("id"), columnNode("payload")],
      values: {
        kind: "ValuesNode",
        values: [{ kind: "PrimitiveValueListNode", values: ["01", "{}"] }],
      },
    } as never;
    expect(describeQueryNode(bareInsert)).toEqual({
      kind: "InsertQueryNode",
      table: "outbox",
      event: null,
    });
  });

  it("skips event extraction for non-outbox INSERT targets", () => {
    // Even if an `event` column exists on a non-outbox table, we
    // don't extract it — the property test only disambiguates
    // outbox fan-outs, and keeping the extractor scoped avoids
    // accidentally pinning semantics for unrelated tables.
    expect(describeQueryNode(insertNodeWithEvent("audit_events", "never-seen") as never)).toEqual({
      kind: "InsertQueryNode",
      table: "audit_events",
      event: null,
    });
  });

  it("extracts the target table from UpdateQueryNode", () => {
    expect(describeQueryNode(updateNode("docs") as never)).toEqual({
      kind: "UpdateQueryNode",
      table: "docs",
      event: null,
    });
  });

  it("extracts the single `from` table from SelectQueryNode", () => {
    expect(describeQueryNode(selectNode("doc_counters") as never)).toEqual({
      kind: "SelectQueryNode",
      table: "doc_counters",
      event: null,
    });
  });

  it("returns table=null for SELECT with multiple FROM sources", () => {
    expect(describeQueryNode(selectNodeMultiFrom("docs", "collections") as never)).toEqual({
      kind: "SelectQueryNode",
      table: null,
      event: null,
    });
  });

  it("returns table=null for SELECT with a JOIN", () => {
    expect(describeQueryNode(selectNodeWithJoin("docs") as never)).toEqual({
      kind: "SelectQueryNode",
      table: null,
      event: null,
    });
  });

  it("extracts the target table from DeleteQueryNode with a single FROM", () => {
    expect(describeQueryNode(deleteNode("outbox") as never)).toEqual({
      kind: "DeleteQueryNode",
      table: "outbox",
      event: null,
    });
  });

  it("returns table=null for DELETE with multiple FROM sources", () => {
    const multiFromDelete = {
      kind: "DeleteQueryNode",
      from: { kind: "FromNode", froms: [tableNode("a"), tableNode("b")] },
    } as never;
    expect(describeQueryNode(multiFromDelete)).toEqual({
      kind: "DeleteQueryNode",
      table: null,
      event: null,
    });
  });

  it("returns table=null when the from source is not a TableNode", () => {
    const subqueryFromSelect = {
      kind: "SelectQueryNode",
      from: {
        kind: "FromNode",
        froms: [{ kind: "SelectQueryNode" }],
      },
    } as never;
    expect(describeQueryNode(subqueryFromSelect)).toEqual({
      kind: "SelectQueryNode",
      table: null,
      event: null,
    });
  });

  it("returns kind passthrough with table=null for unrecognised node kinds", () => {
    expect(describeQueryNode({ kind: "RawNode" } as never)).toEqual({
      kind: "RawNode",
      table: null,
      event: null,
    });
  });

  it("returns table=null when InsertQueryNode.into is missing", () => {
    expect(describeQueryNode({ kind: "InsertQueryNode" } as never)).toEqual({
      kind: "InsertQueryNode",
      table: null,
      event: null,
    });
  });
});
