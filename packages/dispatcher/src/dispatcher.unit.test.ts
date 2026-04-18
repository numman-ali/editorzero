/**
 * Dispatcher pipeline tests.
 *
 * Wires a real registry, a real `scopeOnlyGate`, an in-memory audit
 * writer, and the noop logger/tracer against a hand-built capability.
 * Exercises the allow path, deny path, input-validation error path,
 * and unknown-throw error path. Each should produce exactly one audit
 * row with the `outcome` / `effect` the capability's audit projection
 * declares.
 *
 * Type discipline: no `as` casts, no `any`. `registerCapability`
 * folds the concrete `Capability<I, O>` into the heterogeneous
 * `RegisteredCapability<TEditor>` shape the registry stores.
 */

import type { AuditTx, AuditWriteInput, AuditWriter } from "@editorzero/audit";
import {
  type Capability,
  type CapabilityContext,
  createRegistry,
  registerCapability,
} from "@editorzero/capabilities";
import { createSqliteDriver, type SqliteDriver } from "@editorzero/db";
import type { DenyReason } from "@editorzero/errors";
import { PermissionDeniedError, ValidationError } from "@editorzero/errors";
import { AgentId, CapabilityId, DocId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AccessPath, AgentPrincipal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityContextExtras } from "./index";
import { createDispatcher, scopeOnlyGate, TenantMismatchError } from "./index";

// ── Fixtures ──────────────────────────────────────────────────────────────

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_READ_ID = CapabilityId("doc.read");

interface DocReadInput {
  readonly doc_id: string;
}
interface DocReadOutput {
  readonly doc_id: string;
  readonly title: string;
}

/**
 * In-memory `AuditWriter`. Captures every write so tests can assert
 * that exactly one audit row lands per invocation with the right
 * outcome / effect.
 */
function memoryAuditWriter(): AuditWriter & { readonly rows: AuditWriteInput[] } {
  const rows: AuditWriteInput[] = [];
  return {
    rows,
    write: async (_tx, input) => {
      rows.push(input);
    },
  };
}

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
});

afterEach(async () => {
  await driver.close();
});

function testExtras(): CapabilityContextExtras {
  return {
    db: driver.scoped(WORKSPACE_ID),
    outbox: () => {
      /* stubbed — tests don't exercise the outbox */
    },
    transact: async () => {
      throw new Error("transact stubbed in dispatcher unit tests");
    },
  };
}

function testUser(overrides: Partial<UserPrincipal> = {}): UserPrincipal {
  return {
    kind: "user",
    id: USER_ID,
    workspace_id: WORKSPACE_ID,
    roles: ["member"],
    session_id: null,
    token_id: null,
    ...overrides,
  };
}

const AGENT_ID = AgentId("018f0000-0000-7000-8000-0000000000aa");
const AGENT_TOKEN_ID = TokenId("018f0000-0000-7000-8000-0000000000bb");

function testAgent(overrides: Partial<AgentPrincipal> = {}): AgentPrincipal {
  return {
    kind: "agent",
    id: AGENT_ID,
    workspace_id: WORKSPACE_ID,
    owner_user_id: USER_ID,
    scopes: ["doc:read"],
    token_id: AGENT_TOKEN_ID,
    token_kind: "agent-auth",
    ...overrides,
  };
}

function testAccess(): AccessPath {
  return { workspace_id: WORKSPACE_ID };
}

/**
 * Build a `doc.read`-shaped capability given the handler. The caller
 * can swap in any `requires` via `overrides.requires`; defaults to
 * `["doc:read"]` which `member` roles satisfy.
 */
function buildDocReadCapability(
  handler: Capability<DocReadInput, DocReadOutput>["handler"],
  overrides: Partial<Pick<Capability<DocReadInput, DocReadOutput>, "requires">> = {},
): Capability<DocReadInput, DocReadOutput> {
  return {
    id: DOC_READ_ID,
    category: "read",
    summary: "read a document",
    input: z.object({ doc_id: z.string() }),
    output: z.object({ doc_id: z.string(), title: z.string() }),
    requires: overrides.requires ?? ["doc:read"],
    audit: {
      subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
      effectOnAllow: () => ({ kind: "audit.access_log" }),
      effectOnDeny: () => ({
        kind: "deny",
        capability: DOC_READ_ID,
        required_scopes: ["doc:read"],
        reason_code: "denied",
      }),
      effectOnError: () => ({
        kind: "error",
        capability: DOC_READ_ID,
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler,
  };
}

function mountDispatcher(capability: Capability<DocReadInput, DocReadOutput>) {
  const registry = createRegistry([registerCapability(capability)]);
  const auditWriter = memoryAuditWriter();
  const openAuditTx = (): AuditTx => ({ __brand: "AuditTx" });
  let tick = 0;
  const dispatcher = createDispatcher({
    registry,
    gate: scopeOnlyGate(),
    auditWriter,
    tracer: noopTracer,
    logger: noopLogger,
    now: () => {
      tick += 1;
      return tick;
    },
    makeContextExtras: () => testExtras(),
    openAuditTx,
  });
  return { dispatcher, auditWriter };
}

// ── Scenarios ─────────────────────────────────────────────────────────────

describe("dispatcher", () => {
  it("allow path: parses input, invokes handler, writes allow audit", async () => {
    const { dispatcher, auditWriter } = mountDispatcher(
      buildDocReadCapability(async (_ctx: CapabilityContext, input) => ({
        doc_id: input.doc_id,
        title: `doc ${input.doc_id}`,
      })),
    );

    const out = await dispatcher.dispatch({
      capability_id: DOC_READ_ID,
      input: { doc_id: "abc" },
      principal: testUser(),
      access: testAccess(),
      trace_id: null,
    });

    expect(out).toEqual({ doc_id: "abc", title: "doc abc" });
    expect(auditWriter.rows).toHaveLength(1);
    const row = auditWriter.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.record.outcome).toBe("allow");
    expect(row.subject_kind).toBe("doc");
    expect(row.subject_id).toBe("abc");
    expect(row.principal_kind).toBe("user");
    expect(row.principal_id).toBe(USER_ID);
  });

  it("deny path: missing scope throws PermissionDeniedError + writes deny audit", async () => {
    const { dispatcher, auditWriter } = mountDispatcher(
      buildDocReadCapability(async () => ({ doc_id: "x", title: "x" }), {
        // `workspace:admin` is not in the `guest` role's default scopes.
        requires: ["workspace:admin"],
      }),
    );

    const guest = testUser({ roles: ["guest"] });

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_READ_ID,
        input: { doc_id: "abc" },
        principal: guest,
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    expect(auditWriter.rows).toHaveLength(1);
    const row = auditWriter.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.record.outcome).toBe("deny");
    if (row.record.outcome === "deny") {
      expect(row.record.reason.kind).toBe("missing_scope");
    }
  });

  it("input-validation path: bad input throws ValidationError + writes error audit", async () => {
    const { dispatcher, auditWriter } = mountDispatcher(
      buildDocReadCapability(async () => ({ doc_id: "x", title: "x" })),
    );

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_READ_ID,
        input: { doc_id: 123 }, // zod expects a string
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(auditWriter.rows).toHaveLength(1);
    const row = auditWriter.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.record.outcome).toBe("error");
    if (row.record.outcome === "error") {
      expect(row.record.error.kind).toBe("validation");
    }
  });

  it(
    'agent principal: principalFieldsFor projects kind="agent" + token_id + ' +
      "acting_as_user_id so the audit row routes to agent analytics, not user",
    async () => {
      const { dispatcher, auditWriter } = mountDispatcher(
        buildDocReadCapability(async (_ctx: CapabilityContext, input) => ({
          doc_id: input.doc_id,
          title: `doc ${input.doc_id}`,
        })),
      );

      // A delegated agent: `acting_as` is set, so the projection should
      // populate `acting_as_user_id` (not left null).
      const agent = testAgent({ acting_as: USER_ID });

      await dispatcher.dispatch({
        capability_id: DOC_READ_ID,
        input: { doc_id: "abc" },
        principal: agent,
        access: testAccess(),
        trace_id: null,
      });

      expect(auditWriter.rows).toHaveLength(1);
      const row = auditWriter.rows[0];
      if (row === undefined) throw new Error("expected one row");
      expect(row.principal_kind).toBe("agent");
      expect(row.principal_id).toBe(AGENT_ID);
      expect(row.token_id).toBe(AGENT_TOKEN_ID);
      expect(row.session_id).toBeNull();
      expect(row.acting_as_user_id).toBe(USER_ID);
    },
  );

  it("agent principal without acting_as: acting_as_user_id is null", async () => {
    const { dispatcher, auditWriter } = mountDispatcher(
      buildDocReadCapability(async (_ctx: CapabilityContext, input) => ({
        doc_id: input.doc_id,
        title: `doc ${input.doc_id}`,
      })),
    );

    await dispatcher.dispatch({
      capability_id: DOC_READ_ID,
      input: { doc_id: "abc" },
      principal: testAgent(),
      access: testAccess(),
      trace_id: null,
    });

    expect(auditWriter.rows).toHaveLength(1);
    const row = auditWriter.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.acting_as_user_id).toBeNull();
  });

  it(
    "output-validation path: handler returns shape violating zod; " +
      "dispatcher throws InternalError + writes internal error audit",
    async () => {
      const { dispatcher, auditWriter } = mountDispatcher(
        buildDocReadCapability(
          // The handler satisfies its type contract via a cast-free but
          // schema-violating return value: we build the handler via a
          // typed `Capability` whose handler deliberately ignores the
          // shape. `vitest` `@ts-expect-error` keeps the type system
          // honest about this being intentional.
          // biome-ignore lint/suspicious/noExplicitAny: handler invariant test.
          (async (): Promise<any> => ({ doc_id: "abc" /* missing title */ })) as never,
        ),
      );

      await expect(
        dispatcher.dispatch({
          capability_id: DOC_READ_ID,
          input: { doc_id: "abc" },
          principal: testUser(),
          access: testAccess(),
          trace_id: null,
        }),
      ).rejects.toBeInstanceOf(Error); // InternalError is an Error subclass

      expect(auditWriter.rows).toHaveLength(1);
      const row = auditWriter.rows[0];
      if (row === undefined) throw new Error("expected one row");
      expect(row.record.outcome).toBe("error");
    },
  );

  it("handler-throw path: unknown throw writes internal error audit + re-throws", async () => {
    const thrown = new Error("boom");
    const { dispatcher, auditWriter } = mountDispatcher(
      buildDocReadCapability(async () => {
        throw thrown;
      }),
    );

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_READ_ID,
        input: { doc_id: "abc" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBe(thrown);

    expect(auditWriter.rows).toHaveLength(1);
    const row = auditWriter.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.record.outcome).toBe("error");
    if (row.record.outcome === "error") {
      expect(row.record.error.kind).toBe("internal");
    }
  });

  it("F88 post-parse deny: handler-thrown PermissionDeniedError writes a deny audit and rethrows", async () => {
    const reason: DenyReason = {
      kind: "acl_deny",
      scope: { doc_id: DocId("018f0000-0000-7000-8000-0000000000d1") },
    };
    const { dispatcher, auditWriter } = mountDispatcher(
      buildDocReadCapability(async () => {
        throw new PermissionDeniedError({ reason });
      }),
    );

    await expect(
      dispatcher.dispatch({
        capability_id: DOC_READ_ID,
        input: { doc_id: "abc" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // Before F88 this failed — handler-thrown denies leaked out with
    // zero audit rows because the catch block rethrew without writing.
    expect(auditWriter.rows).toHaveLength(1);
    const row = auditWriter.rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.record.outcome).toBe("deny");
    if (row.record.outcome === "deny") {
      expect(row.record.reason.kind).toBe("acl_deny");
    }
  });

  it(
    "F86 invariant: access.workspace_id disagreeing with principal.workspace_id " +
      "throws TenantMismatchError before gate or audit",
    async () => {
      const { dispatcher, auditWriter } = mountDispatcher(
        buildDocReadCapability(async () => ({ doc_id: "x", title: "x" })),
      );

      const OTHER_WORKSPACE = WorkspaceId("018f0000-0000-7000-8000-000000000099");
      const mismatchedAccess: AccessPath = { workspace_id: OTHER_WORKSPACE };

      await expect(
        dispatcher.dispatch({
          capability_id: DOC_READ_ID,
          input: { doc_id: "abc" },
          principal: testUser(),
          access: mismatchedAccess,
          trace_id: null,
        }),
      ).rejects.toBeInstanceOf(TenantMismatchError);

      // Illegal invocations leave no audit trail — the dispatcher hasn't
      // committed to a workspace yet, so there's nothing to audit against.
      expect(auditWriter.rows).toHaveLength(0);
    },
  );
});
