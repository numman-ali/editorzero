/**
 * `createQueryFaultPlugin` — Kysely plugin factory for crash-fuzz tests.
 *
 * Exposes a narrow hook the write-path-atomicity property test
 * (`packages/dispatcher/prop/writepath-atomicity.test.ts`) uses to
 * inject synthetic faults mid-transaction AND to prove individual
 * queries ran inside the faulted tx. Every query the plugin sees is
 * tagged with its `{kind, table}` shape (see {@link QueryTag}) and the
 * tag is handed to the caller-supplied `onQuery` callback; if the
 * callback throws, the plugin propagates the throw, which causes
 * Kysely to skip the query and surface the error to the awaiting
 * caller. The enclosing SQL tx then rolls back as a unit.
 *
 * **Why tags, not just counts.** An exact-count guard catches the
 * common "write tx shrinks" regression but has a blind spot where
 * two different queries swap places across the tx boundary (e.g., the
 * allow-audit INSERT pair moves out and two unrelated statements
 * move in) — total stays constant, atomicity scope changes. Tagging
 * each query with its target table lets the property test's baseline
 * assert that specific INSERTs (`audit_events`, `outbox`) ran inside
 * the counted tx, so that specific regression surfaces as a baseline
 * failure rather than a silent coverage gap.
 *
 * **Why this lives in `@editorzero/db`.** `no-raw-kysely-outside-db`
 * (architecture.md §8.1a / §17, enforced today by
 * `scripts/coherence.ts`) pins every `from "kysely"` import to
 * `packages/db/**`. A test in `@editorzero/dispatcher` that needs to
 * layer a plugin onto a `Transaction<SystemDatabase>` therefore can't
 * import `KyselyPlugin` itself; exposing the plugin via a typed
 * factory here keeps the boundary clean. The test imports only
 * `createQueryFaultPlugin` + `QueryTag` — no Kysely surface leaks
 * outside db.
 *
 * **Not a production utility.** The plugin has no correctness or
 * tracing value; it exists solely to let the property test verify
 * the write-path tx's all-or-none guarantee under injected faults.
 * Production composition does not use it. Kept in the main barrel
 * (rather than a separate `/test-utils` subpath) because the db
 * package already exports other test-adjacent primitives like
 * `asAuditTx` — one more small factory is not worth the extra
 * `exports` map entry.
 */

import type {
  ColumnNode,
  DeleteQueryNode,
  InsertQueryNode,
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  SelectQueryNode,
  TableNode,
  UnknownRow,
  UpdateQueryNode,
} from "kysely";

/**
 * Coarse identity of a Kysely query node. `kind` is the node-kind
 * string Kysely emits (`"InsertQueryNode"`, `"SelectQueryNode"`, etc.);
 * `table` is the top-level target table when the node has an
 * unambiguous single source (single `TableNode` in `from`/`into`/etc.),
 * `null` otherwise — multi-source SELECT (multiple `froms`), any
 * SELECT with JOINs, sub-query / alias / raw node roots, DDL, CTE
 * compound statements. `event` is the `event` column's literal value
 * when the node is an `InsertQueryNode` targeting `outbox` (so the
 * property test can distinguish fan-out events that otherwise collapse
 * to the same `(kind, table)` tuple — e.g., `outbox(doc.updated)`
 * vs. `outbox(audit.appended)`); `null` for everything else.
 */
export interface QueryTag {
  readonly kind: string;
  readonly table: string | null;
  readonly event: string | null;
}

function tableNameOf(node: OperationNode | undefined): string | null {
  if (!node) return null;
  if (node.kind === "TableNode") {
    return (node as TableNode).table.identifier.name;
  }
  return null;
}

/**
 * Extract the `event` column's literal value from an
 * `InsertQueryNode` targeting `outbox`. The writer passes a single
 * row (one value list), Kysely serialises it as either a
 * `PrimitiveValueListNode` (direct array of literals) or a
 * `ValueListNode` wrapping `ValueNode`s — we handle both shapes.
 * Returns `null` when the shape is unexpected (e.g., a SELECT-into
 * source, bulk INSERT with multiple rows, parameter node we can't
 * materialise statically). That's tolerable: the property test's
 * event-discriminated assertions only rely on this succeeding for
 * the writer's simple literal INSERTs, which is the production path.
 */
function extractInsertEvent(node: InsertQueryNode): string | null {
  const columns = node.columns;
  const values = node.values;
  if (!columns || !values || values.kind !== "ValuesNode") return null;
  const eventIdx = columns.findIndex((c) => (c as ColumnNode).column.name === "event");
  if (eventIdx < 0) return null;
  const valuesNode = values as unknown as {
    readonly values: readonly OperationNode[];
  };
  const firstRow = valuesNode.values[0];
  if (!firstRow) return null;
  if (firstRow.kind === "PrimitiveValueListNode") {
    const list = firstRow as unknown as { readonly values: readonly unknown[] };
    const raw = list.values[eventIdx];
    return typeof raw === "string" ? raw : null;
  }
  if (firstRow.kind === "ValueListNode") {
    const list = firstRow as unknown as {
      readonly values: readonly OperationNode[];
    };
    const valueNode = list.values[eventIdx] as unknown as {
      readonly kind: string;
      readonly value: unknown;
    };
    if (valueNode?.kind === "ValueNode" && typeof valueNode.value === "string") {
      return valueNode.value;
    }
  }
  return null;
}

/**
 * Derive a `QueryTag` from a Kysely `RootOperationNode`. Covers the
 * four query kinds the write path emits (INSERT / UPDATE / SELECT /
 * DELETE); any other node kind (DDL, raw, compound sets, etc.) returns
 * `{kind, table: null, event: null}` — the property test doesn't rely
 * on table identity for those.
 */
export function describeQueryNode(node: RootOperationNode): QueryTag {
  switch (node.kind) {
    case "InsertQueryNode": {
      const insert = node as InsertQueryNode;
      const table = tableNameOf(insert.into);
      const event = table === "outbox" ? extractInsertEvent(insert) : null;
      return { kind: "InsertQueryNode", table, event };
    }
    case "UpdateQueryNode":
      return {
        kind: "UpdateQueryNode",
        table: tableNameOf((node as UpdateQueryNode).table),
        event: null,
      };
    case "SelectQueryNode": {
      const sel = node as SelectQueryNode;
      const froms = sel.from?.froms;
      const hasJoins = sel.joins !== undefined && sel.joins.length > 0;
      // Single-source unjoined SELECTs get a concrete table tag.
      // Everything else (no FROM, multiple FROMs, any JOIN) is
      // ambiguous at this granularity and gets `null` — the property
      // test must not silently attribute a multi-table read to its
      // first source (Codex P3, bkog7a2h0).
      const unambiguous = froms !== undefined && froms.length === 1 && !hasJoins;
      return {
        kind: "SelectQueryNode",
        table: unambiguous ? tableNameOf(froms[0]) : null,
        event: null,
      };
    }
    case "DeleteQueryNode": {
      const froms = (node as DeleteQueryNode).from.froms;
      return {
        kind: "DeleteQueryNode",
        table: froms.length === 1 ? tableNameOf(froms[0]) : null,
        event: null,
      };
    }
    default:
      return { kind: node.kind, table: null, event: null };
  }
}

export function createQueryFaultPlugin(onQuery: (tag: QueryTag) => void): KyselyPlugin {
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      // If `onQuery` throws, Kysely's plugin pipeline short-circuits
      // before `compileQuery` runs — the query never reaches the
      // driver's `executeQuery`, the SQL tx rolls back when the throw
      // unwinds past `withSystemTx`'s `execute(fn)`.
      onQuery(describeQueryNode(args.node));
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return args.result;
    },
  };
}
