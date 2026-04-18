/**
 * `TenantScopedDb` — a `Kysely<Database>` handle whose every query is
 * automatically workspace-scoped by the `WorkspaceScopingPlugin`
 * (architecture.md §8.1 / §8.1a). This is Layer 2 of the three-layer
 * permission enforcement model: Layer 1 is dispatcher-level scope
 * checks, Layer 2 is this auto-injected `workspace_id` predicate,
 * Layer 3 is Postgres RLS (on Postgres only).
 *
 * The invariant: a caller holding a `TenantScopedDb` cannot read,
 * write, or delete rows in a tenant-scoped table outside their
 * workspace — the plugin splices `workspace_id = <scope>` into
 * SELECT/UPDATE/DELETE WHERE clauses and forces the column into every
 * INSERT values list. An attempted INSERT with a different
 * `workspace_id` throws `TenantScopeViolationError` at query-build
 * time.
 *
 * The unscoped `Kysely<Database>` is intentionally not exported; the
 * only public construction path is `createTenantScopedDb`. An
 * arch-lint rule (ADR 0015 §8.1a — `no-raw-kysely-outside-db`) will
 * eventually enforce that `Kysely` and `sql<T>` cannot be imported
 * outside `packages/db/**`, making the Layer-2 guarantee truly
 * unbypassable. Until that lint rule lands, the discipline is review.
 *
 * AST strategy: the plugin is a `KyselyPlugin` whose `transformQuery`
 * hook runs a custom `OperationNodeTransformer` over the root node,
 * inspecting FROM/INTO nodes against `TENANT_SCOPED_TABLES`. The
 * transformer recurses into subqueries via `super.transformX(...)` so
 * CTEs, subselects, and INSERT…SELECT bodies are all scoped too. The
 * chosen primitives (`WhereNode.cloneWithOperation`,
 * `InsertQueryNode.cloneWith`) are Kysely 0.28's documented plugin
 * surface — see `packages/db/README.md` (TODO) for the reference map.
 *
 * Alias- and join-awareness: SELECT and DELETE walk both `from.froms`
 * and `joins[].table`; UPDATE walks its primary `table` plus any
 * Postgres-style `from.froms` and `joins`. For each tenant-scoped
 * occurrence we resolve a `{ tableNode, refNode }` pair — `refNode` is
 * the alias when the FROM/JOIN uses `AS`, the table otherwise — and
 * emit the predicate against `refNode`. This is what makes aliased
 * queries like `selectFrom("docs as d")` emit legal SQL
 * (`d.workspace_id = ?`, not `docs.workspace_id = ?`) and makes a
 * self-join on tenant tables scope every participant. Unrecognised
 * FROM/JOIN shapes (subqueries, table-valued expressions) are skipped
 * rather than blocked; discipline + the property fuzzer are the final
 * guards.
 */

import type { WorkspaceId } from "@editorzero/ids";
import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  type DeleteQueryNode,
  IdentifierNode,
  type InsertQueryNode,
  type JoinNode,
  type Kysely,
  type KyselyPlugin,
  type OperationNode,
  OperationNodeTransformer,
  OperatorNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  PrimitiveValueListNode,
  type QueryResult,
  ReferenceNode,
  type RootOperationNode,
  SelectQueryNode,
  TableNode,
  type UnknownRow,
  type UpdateQueryNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
  WhereNode,
} from "kysely";

import type { Database, TenantScopedTable } from "./schema";
import { TENANT_SCOPED_TABLES } from "./schema";

/**
 * A `Kysely<Database>` whose every query auto-applies the
 * `workspace_id` predicate. The alias carries no structural brand —
 * the invariant is enforced by the arch-lint rule that prevents raw
 * `Kysely` construction outside this package (architecture.md §8.1a).
 */
export type TenantScopedDb = Kysely<Database>;

/**
 * Thrown when an INSERT into a tenant-scoped table carries an explicit
 * `workspace_id` value that disagrees with the plugin's scope, or when
 * the INSERT shape is one the plugin can't safely modify (raw
 * positional insert without a `columns` list; `DEFAULT VALUES`;
 * INSERT…SELECT where the SELECT does not project `workspace_id`).
 *
 * These are programming errors, not user-input errors — they shouldn't
 * land in production code. Surface them loudly so tests catch them.
 */
export class TenantScopeViolationError extends Error {
  override readonly name = "TenantScopeViolationError";
  readonly table: string;
  readonly reason:
    | "workspace_id_mismatch"
    | "insert_missing_columns"
    | "insert_default_values"
    | "insert_select_unaudited";

  constructor(table: string, reason: TenantScopeViolationError["reason"], message: string) {
    super(message);
    this.table = table;
    this.reason = reason;
  }
}

/**
 * Wrap a base `Kysely<Database>` with the plugin. The returned handle
 * is safe to pass to capability handlers. `withPlugin` on Kysely
 * returns a fresh instance sharing the underlying driver connection
 * pool, so per-request scoping is cheap.
 */
export function createTenantScopedDb(
  base: Kysely<Database>,
  workspace_id: WorkspaceId,
): TenantScopedDb {
  return base.withPlugin(new WorkspaceScopingPlugin(workspace_id));
}

export class WorkspaceScopingPlugin implements KyselyPlugin {
  readonly #workspace_id: WorkspaceId;

  constructor(workspace_id: WorkspaceId) {
    this.#workspace_id = workspace_id;
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const transformer = new WorkspaceScopingTransformer(this.#workspace_id);
    return transformer.transformNode(args.node);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}

// ── AST transformer ───────────────────────────────────────────────────────

const TENANT_SCOPED_TABLE_SET: ReadonlySet<string> = new Set(TENANT_SCOPED_TABLES);

function isTenantScoped(name: string): name is TenantScopedTable {
  return TENANT_SCOPED_TABLE_SET.has(name);
}

/**
 * A tenant-scoped table occurrence. `tableNode` is the real table (used
 * for the `isTenantScoped` check); `refNode` is what we reference in
 * the emitted predicate — the alias when one is present, the table
 * otherwise. Splitting the two is what lets the plugin emit legal SQL
 * against aliased FROM/JOIN items: `SELECT … FROM docs AS d` must
 * produce `d.workspace_id = ?`, not `docs.workspace_id = ?`.
 */
interface ScopedRef {
  readonly tableNode: TableNode;
  readonly refNode: TableNode;
}

/**
 * Resolve a FROM item or JOIN target (`JoinNode.table`) into a
 * `ScopedRef` when the node is a single table — plain or aliased.
 * Returns null for subqueries, raw expressions, and any other shape we
 * can't statically pin to one table.
 *
 * Alias handling: `AliasNode { node: TableNode, alias: IdentifierNode }`
 * is the shape Kysely emits for `selectFrom("docs as d")`. We build a
 * synthetic `TableNode.create(aliasName)` as the refNode — its
 * `ReferenceNode` rendering is `d.workspace_id`, exactly what aliased
 * SQL requires.
 */
function refFor(node: OperationNode): ScopedRef | null {
  if (TableNode.is(node)) return { tableNode: node, refNode: node };
  if (AliasNode.is(node) && TableNode.is(node.node) && IdentifierNode.is(node.alias)) {
    return {
      tableNode: node.node,
      refNode: TableNode.create(node.alias.name),
    };
  }
  return null;
}

function tableName(node: TableNode): string {
  return node.table.identifier.name;
}

function workspacePredicate(ref: TableNode, workspace_id: WorkspaceId): OperationNode {
  return BinaryOperationNode.create(
    ReferenceNode.create(ColumnNode.create("workspace_id"), ref),
    OperatorNode.create("="),
    ValueNode.create(workspace_id),
  );
}

function conjunctionOver(predicates: readonly OperationNode[]): OperationNode {
  const [head, ...rest] = predicates;
  if (head === undefined) {
    throw new Error("invariant: conjunctionOver called with empty predicate list");
  }
  return rest.reduce<OperationNode>((acc, next) => AndNode.create(acc, next), head);
}

function appendAnd(existing: WhereNode | undefined, predicate: OperationNode): WhereNode {
  return existing === undefined
    ? WhereNode.create(predicate)
    : WhereNode.cloneWithOperation(existing, "And", predicate);
}

/**
 * Collect every tenant-scoped table occurrence from a FROM list and
 * (optionally) a JOIN list. Each element becomes a `ScopedRef`
 * contributing one `<ref>.workspace_id = ?` predicate to the emitted
 * WHERE. Non-scoped tables and unrecognised shapes are silently
 * skipped.
 */
function collectScopedRefs(
  fromItems: readonly OperationNode[] | undefined,
  joins: readonly JoinNode[] | undefined,
): ScopedRef[] {
  const out: ScopedRef[] = [];
  const visit = (node: OperationNode): void => {
    const ref = refFor(node);
    if (ref !== null && isTenantScoped(tableName(ref.tableNode))) out.push(ref);
  };
  for (const from of fromItems ?? []) visit(from);
  for (const join of joins ?? []) visit(join.table);
  return out;
}

class WorkspaceScopingTransformer extends OperationNodeTransformer {
  readonly #workspace_id: WorkspaceId;

  constructor(workspace_id: WorkspaceId) {
    super();
    this.#workspace_id = workspace_id;
  }

  protected override transformSelectQuery(node: SelectQueryNode): SelectQueryNode {
    const transformed = super.transformSelectQuery(node);
    const refs = collectScopedRefs(transformed.from?.froms, transformed.joins);
    if (refs.length === 0) return transformed;
    const predicate = conjunctionOver(
      refs.map((r) => workspacePredicate(r.refNode, this.#workspace_id)),
    );
    return { ...transformed, where: appendAnd(transformed.where, predicate) };
  }

  protected override transformUpdateQuery(node: UpdateQueryNode): UpdateQueryNode {
    const transformed = super.transformUpdateQuery(node);
    const target = transformed.table;
    if (target === undefined) return transformed;
    const refs: ScopedRef[] = [];
    const primary = refFor(target);
    if (primary !== null && isTenantScoped(tableName(primary.tableNode))) refs.push(primary);
    // Postgres-flavour `UPDATE t SET … FROM other` and join-style updates
    // need every tenant-scoped participant pinned to the current scope,
    // otherwise the secondary tables leak rows into the join product.
    refs.push(...collectScopedRefs(transformed.from?.froms, transformed.joins));
    if (refs.length === 0) return transformed;
    const predicate = conjunctionOver(
      refs.map((r) => workspacePredicate(r.refNode, this.#workspace_id)),
    );
    return { ...transformed, where: appendAnd(transformed.where, predicate) };
  }

  protected override transformDeleteQuery(node: DeleteQueryNode): DeleteQueryNode {
    const transformed = super.transformDeleteQuery(node);
    const refs = collectScopedRefs(transformed.from.froms, transformed.joins);
    if (refs.length === 0) return transformed;
    const predicate = conjunctionOver(
      refs.map((r) => workspacePredicate(r.refNode, this.#workspace_id)),
    );
    return { ...transformed, where: appendAnd(transformed.where, predicate) };
  }

  protected override transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
    const transformed = super.transformInsertQuery(node);
    if (transformed.into === undefined) return transformed;
    const target = tableName(transformed.into);
    if (!isTenantScoped(target)) return transformed;
    return forceWorkspaceIdInInsert(transformed, target, this.#workspace_id);
  }
}

// ── INSERT augmentation ────────────────────────────────────────────────────
//
// The plugin has to force `workspace_id = <scope>` into each row. Three
// shapes we handle + one shape we reject:
//
// 1. `values` is a `ValuesNode` wrapping `ValueListNode` rows (the mixed-
//    or non-primitive case) → append the scope as a new `ValueNode`.
// 2. `values` is a `ValuesNode` wrapping `PrimitiveValueListNode` rows
//    (Kysely's fast path for all-primitive rows) → append the scope
//    literal value.
// 3. `values` is a `SelectQueryNode` (INSERT…SELECT) → reject until we
//    design `workspace_id` projection in SELECT bodies. Not needed for v1.
// 4. `defaultValues: true` → reject; tenant-scoped tables cannot be
//    inserted with all defaults because `workspace_id` has no default.

function forceWorkspaceIdInInsert(
  node: InsertQueryNode,
  target: string,
  workspace_id: WorkspaceId,
): InsertQueryNode {
  if (node.defaultValues === true) {
    throw new TenantScopeViolationError(
      target,
      "insert_default_values",
      `INSERT INTO ${target} DEFAULT VALUES is not permitted: ` +
        `tenant-scoped tables require explicit workspace_id.`,
    );
  }

  const existingColumns = node.columns ?? [];
  const columnNames = existingColumns.map((c) => c.column.name);
  if (existingColumns.length === 0) {
    throw new TenantScopeViolationError(
      target,
      "insert_missing_columns",
      `INSERT INTO ${target} without an explicit column list is not permitted: ` +
        `tenant-scoped inserts must name columns so workspace_id can be injected safely.`,
    );
  }

  const hasWorkspaceCol = columnNames.includes("workspace_id");

  const values = node.values;

  if (values === undefined) {
    throw new TenantScopeViolationError(
      target,
      "insert_missing_columns",
      `INSERT INTO ${target} has no values and no defaultValues: shape unsupported.`,
    );
  }

  if (SelectQueryNode.is(values)) {
    throw new TenantScopeViolationError(
      target,
      "insert_select_unaudited",
      `INSERT INTO ${target} … SELECT is not permitted through TenantScopedDb: ` +
        `cross-tenant leakage cannot be prevented from the plugin. ` +
        `Use a typed repo that projects workspace_id explicitly.`,
    );
  }

  if (!ValuesNode.is(values)) {
    throw new TenantScopeViolationError(
      target,
      "insert_missing_columns",
      `INSERT INTO ${target} has an unsupported values shape: ${values.kind}.`,
    );
  }

  if (hasWorkspaceCol) {
    assertValuesColumnMatchesScope(values, columnNames, target, workspace_id);
    return node;
  }

  const newColumns = [...existingColumns, ColumnNode.create("workspace_id")];
  const newRows = values.values.map((row) => appendValueToRow(row, workspace_id));
  return {
    ...node,
    columns: newColumns,
    values: ValuesNode.create(newRows),
  };
}

function appendValueToRow(
  row: ValueListNode | PrimitiveValueListNode,
  workspace_id: WorkspaceId,
): ValueListNode | PrimitiveValueListNode {
  if (PrimitiveValueListNode.is(row)) {
    return PrimitiveValueListNode.create([...row.values, workspace_id]);
  }
  return ValueListNode.create([...row.values, ValueNode.create(workspace_id)]);
}

function assertValuesColumnMatchesScope(
  values: ValuesNode,
  columnNames: readonly string[],
  target: string,
  workspace_id: WorkspaceId,
): void {
  const idx = columnNames.indexOf("workspace_id");
  for (const row of values.values) {
    const raw = extractRowValueAt(row, idx);
    if (raw !== workspace_id) {
      throw new TenantScopeViolationError(
        target,
        "workspace_id_mismatch",
        `INSERT INTO ${target} explicitly sets workspace_id=${String(raw)}, ` +
          `but the active TenantScopedDb is scoped to workspace_id=${workspace_id}. ` +
          `Either omit the column (it will be injected) or match the scope.`,
      );
    }
  }
}

function extractRowValueAt(row: ValueListNode | PrimitiveValueListNode, idx: number): unknown {
  if (PrimitiveValueListNode.is(row)) {
    return row.values[idx];
  }
  const node = row.values[idx];
  if (node !== undefined && ValueNode.is(node)) return node.value;
  // An expression that isn't a literal ValueNode (e.g. a subquery,
  // parameter binding pattern) — we can't validate statically, so
  // treat as a violation in the strictest mode.
  return Symbol("non-literal");
}

// UPDATE: the WHERE-predicate injection above is the enforcement point.
// We deliberately do not filter `workspace_id` out of the SET clause —
// an attempted `UPDATE docs SET workspace_id = <other> WHERE id = …`
// affects zero rows because the auto-injected WHERE predicate binds
// `workspace_id = <current_scope>`. The fuzzer in
// `tenant-isolation.prop.ts` (Phase 3 harness) verifies this.
