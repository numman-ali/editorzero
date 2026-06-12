/**
 * Ceiling → handler wiring proof (ADR 0040 Step 6).
 *
 * The matrix in `ceiling.unit.test.ts` proves the PREDICATE; this file
 * proves every doc handler actually CALLS it — the F88 channel fires
 * end-to-end through each handler's own row fetch, in the right order.
 * One file rather than nine scattered cases so "which handlers are
 * ceiling-wired" is a single auditable list; a future doc capability
 * that forgets the assert shows up here as a missing entry.
 *
 * World: one closed Space, one collection inside it, docs created by
 * OTHER (a closed-space member); the caller is OUTSIDER — a workspace
 * member with `member`-role scopes (so the scope gate would pass) but
 * no Space membership, no grants, not the creator. Every wired
 * mutation/read must reject with `PermissionDeniedError` and reach NO
 * side effect: `ctx.transact` / `ctx.outbox` THROW if touched, so a
 * handler that asserts too late fails loudly here.
 *
 * `doc.list` is the exception shape: filtering, not denying — the
 * closed-space doc is silently absent while legacy docs remain.
 */

import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  DOCS_DDL,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { PermissionDeniedError, ValidationError } from "@editorzero/errors";
import {
  AgentId,
  CollectionId,
  DocId,
  GrantId,
  SpaceId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, UserPrincipal } from "@editorzero/principal";
import { MemorySyncService } from "@editorzero/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { docCreate } from "../doc/create";
import { docDelete } from "../doc/delete";
import { docGet } from "../doc/get";
import { docList } from "../doc/list";
import { docMove } from "../doc/move";
import { docPublish } from "../doc/publish";
import { docRename } from "../doc/rename";
import { docRestore } from "../doc/restore";
import { docUnpublish } from "../doc/unpublish";
import { docUpdate } from "../doc/update";
import type { CapabilityContext } from "../kernel";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const OUTSIDER = UserId("018f0000-0000-7000-8000-0000000000a1");
const OTHER = UserId("018f0000-0000-7000-8000-0000000000a2");
const GRANTEE = UserId("018f0000-0000-7000-8000-0000000000a3");
const AGENT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const AGENT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");
const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_OPEN = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const S_MISSING = SpaceId("018f0000-0000-7000-8000-0000000000e9");
const C_CLOSED = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const C_CLOSED2 = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const C_OPEN = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const C_DANGLING = CollectionId("018f0000-0000-7000-8000-0000000000c4");
const D_FOREIGN = DocId("018f0000-0000-7000-8000-0000000000d1");
const D_FOREIGN_TRASHED = DocId("018f0000-0000-7000-8000-0000000000d2");
const D_LEGACY = DocId("018f0000-0000-7000-8000-0000000000d3");
const D_ANOMALY = DocId("018f0000-0000-7000-8000-0000000000d4");
const SPACE_GRANT = GrantId("018f0000-0000-7000-8000-0000000000f1");

let driver: SqliteDriver;
let sync: MemorySyncService;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  driver.exec(DOCS_DDL);
  sync = new MemorySyncService();
  const db = driver.scoped(WORKSPACE_A);

  for (const [id, type] of [
    [S_CLOSED, "closed"],
    [S_OPEN, "open"],
  ] as const) {
    await db
      .insertInto("spaces")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        kind: "team",
        type,
        owner_user_id: null,
        name: `space-${id.slice(-2)}`,
        slug: `space-${id.slice(-2)}`,
        baseline_access: "view",
        created_by: OTHER,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }
  for (const [id, space_id] of [
    [C_CLOSED, S_CLOSED],
    [C_CLOSED2, S_CLOSED],
    [C_OPEN, S_OPEN],
    [C_DANGLING, S_MISSING], // dangling space ref — anomaly placement
  ] as const) {
    await db
      .insertInto("collections")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        space_id,
        title: `col ${id.slice(-2)}`,
        slug: `col-${id.slice(-2)}`,
        order_key: id,
        created_by: OTHER,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }
  await db
    .insertInto("space_members")
    .values({
      workspace_id: WORKSPACE_A,
      space_id: S_CLOSED,
      user_id: OTHER,
      role: "edit",
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await db
    .insertInto("grants")
    .values({
      id: SPACE_GRANT,
      workspace_id: WORKSPACE_A,
      resource_kind: "space",
      resource_id: S_CLOSED,
      subject_kind: "user",
      subject_id: GRANTEE,
      role: "view",
      is_guest: 1,
      created_by: OTHER,
      created_at: 1,
    })
    .execute();
  for (const [id, deleted_at, collection_id, published] of [
    [D_FOREIGN, null, C_CLOSED, true],
    [D_FOREIGN_TRASHED, 9, C_CLOSED, false],
    [D_LEGACY, null, null, false],
    [D_ANOMALY, null, C_DANGLING, false],
  ] as const) {
    await db
      .insertInto("docs")
      .values({
        id,
        workspace_id: WORKSPACE_A,
        collection_id,
        title: `doc ${id.slice(-2)}`,
        slug: `doc-${id.slice(-2)}`,
        order_key: id,
        access_mode: "space",
        published_slug: published ? `doc-${id.slice(-2)}` : null,
        published_at: published ? 1 : null,
        render_version: 0,
        created_by: OTHER,
        created_at: 1,
        updated_at: 1,
        deleted_at,
      })
      .execute();
  }
});

afterEach(async () => {
  await sync.close();
  await driver.close();
});

function user(id: UserId): UserPrincipal {
  return {
    kind: "user",
    id,
    workspace_id: WORKSPACE_A,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

/** Owner is a closed-space member — placement still evaluates the AGENT. */
function agent(acting_as?: UserId): AgentPrincipal {
  return {
    kind: "agent",
    id: AGENT,
    workspace_id: WORKSPACE_A,
    owner_user_id: OTHER,
    scopes: ["doc:write"],
    token_id: AGENT_TOKEN,
    token_kind: acting_as === undefined ? "api-key" : "agent-auth",
    ...(acting_as !== undefined && { acting_as }),
  };
}

function ctxFor(
  principal: UserPrincipal | AgentPrincipal,
  opts: { allowTransact?: boolean } = {},
): CapabilityContext {
  // Side-effect tripwires: a ceiling deny must fire BEFORE any Y.Doc
  // mutation or outbox emit — reaching either is a wiring bug (assert
  // placed after the side effect), not a test gap. Allow-path create
  // tests opt into a real MemorySyncService transact instead.
  const transact: CapabilityContext["transact"] = opts.allowTransact
    ? (doc_id, fn) => sync.transact(doc_id, fn)
    : () => {
        throw new Error("ceiling deny must precede ctx.transact");
      };
  return {
    principal,
    tenant: { workspace_id: WORKSPACE_A },
    db: driver.scoped(WORKSPACE_A),
    transact,
    outbox: () => {
      throw new Error("ceiling deny must precede ctx.outbox");
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1000,
  };
}

function outsiderCtx(): CapabilityContext {
  return ctxFor(user(OUTSIDER));
}

async function expectAclDenyOn(
  run: () => Promise<unknown>,
  scope: { doc_id: DocId } | { collection_id: CollectionId },
) {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(PermissionDeniedError);
  if (thrown instanceof PermissionDeniedError) {
    expect(thrown.reason).toEqual({ kind: "acl_deny", scope });
  }
}

async function expectAclDeny(run: () => Promise<unknown>, doc: DocId) {
  await expectAclDenyOn(run, { doc_id: doc });
}

describe("every wired handler denies the outsider on the closed-space doc", () => {
  it("doc.get", async () => {
    await expectAclDeny(() => docGet.handler(outsiderCtx(), { doc_id: D_FOREIGN }), D_FOREIGN);
  });

  it("doc.update", async () => {
    await expectAclDeny(
      () => docUpdate.handler(outsiderCtx(), { doc_id: D_FOREIGN, ops: [] }),
      D_FOREIGN,
    );
  });

  it("doc.rename", async () => {
    await expectAclDeny(
      () => docRename.handler(outsiderCtx(), { doc_id: D_FOREIGN, title: "taken over" }),
      D_FOREIGN,
    );
  });

  it("doc.move", async () => {
    await expectAclDeny(
      () => docMove.handler(outsiderCtx(), { doc_id: D_FOREIGN, new_collection_id: null }),
      D_FOREIGN,
    );
  });

  it("doc.publish", async () => {
    await expectAclDeny(() => docPublish.handler(outsiderCtx(), { doc_id: D_FOREIGN }), D_FOREIGN);
  });

  it("doc.unpublish", async () => {
    await expectAclDeny(
      () => docUnpublish.handler(outsiderCtx(), { doc_id: D_FOREIGN }),
      D_FOREIGN,
    );
  });

  it("doc.soft_delete", async () => {
    await expectAclDeny(() => docDelete.handler(outsiderCtx(), { doc_id: D_FOREIGN }), D_FOREIGN);
  });

  it("doc.restore — evaluated over the trashed row's stored placement", async () => {
    await expectAclDeny(
      () => docRestore.handler(outsiderCtx(), { doc_id: D_FOREIGN_TRASHED }),
      D_FOREIGN_TRASHED,
    );
  });

  it("the deny did not mutate: the foreign doc's row is byte-identical after every attempt", async () => {
    const before = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .where("id", "=", D_FOREIGN)
      .executeTakeFirst();
    for (const attempt of [
      () => docRename.handler(outsiderCtx(), { doc_id: D_FOREIGN, title: "x" }),
      () => docDelete.handler(outsiderCtx(), { doc_id: D_FOREIGN }),
      () => docUnpublish.handler(outsiderCtx(), { doc_id: D_FOREIGN }),
    ]) {
      await attempt().catch(() => undefined);
    }
    const after = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .where("id", "=", D_FOREIGN)
      .executeTakeFirst();
    expect(after).toEqual(before);
  });
});

describe("doc.list filters instead of denying", () => {
  it("omits the closed-space doc, keeps the legacy doc", async () => {
    const out = await docList.handler(outsiderCtx(), {});
    const ids = out.docs.map((d) => d.id);
    expect(ids).toContain(D_LEGACY);
    expect(ids).not.toContain(D_FOREIGN);
  });
});

// ── doc.create placement gate (Codex Step-6 review HIGH 1) ────────────────
//
// Creating a doc is a placement-changing write: `created_by` makes the
// caller a permanent implicit owner, so an unreachable target collection
// must reject BEFORE the docs INSERT and the Y.Doc seed. The deny path
// runs with the transact tripwire armed — a handler that inserted or
// seeded first would surface as the wrong error class here, and the
// docs-count probe proves no row landed.

async function docsCount(): Promise<number> {
  const rows = await driver.scoped(WORKSPACE_A).selectFrom("docs").select(["id"]).execute();
  return rows.length;
}

describe("doc.create placement gate", () => {
  it("outsider cannot create into a closed-space collection — acl_deny on the collection, no row, no seed", async () => {
    const before = await docsCount();
    await expectAclDenyOn(
      () =>
        docCreate.handler(ctxFor(user(OUTSIDER)), { title: "intrusion", collection_id: C_CLOSED }),
      { collection_id: C_CLOSED },
    );
    expect(await docsCount()).toBe(before);
  });

  it("a non-delegated agent cannot create into the closed space even though its OWNER is a member", async () => {
    await expectAclDenyOn(
      () => docCreate.handler(ctxFor(agent()), { title: "bot intrusion", collection_id: C_CLOSED }),
      { collection_id: C_CLOSED },
    );
  });

  it("a non-delegated agent cannot create into an OPEN space either — the open baseline is user-only", async () => {
    await expectAclDenyOn(
      () => docCreate.handler(ctxFor(agent()), { title: "bot open", collection_id: C_OPEN }),
      { collection_id: C_OPEN },
    );
  });

  it("an anomaly placement (dangling space ref) rejects for everyone — fail closed", async () => {
    await expectAclDenyOn(
      () =>
        docCreate.handler(ctxFor(user(OTHER)), { title: "into limbo", collection_id: C_DANGLING }),
      { collection_id: C_DANGLING },
    );
  });

  it("a space member CAN create into the closed space", async () => {
    const out = await docCreate.handler(ctxFor(user(OTHER), { allowTransact: true }), {
      title: "member entry",
      collection_id: C_CLOSED,
    });
    expect(out.collection_id).toBe(C_CLOSED);
  });

  it("a space-grantee (guest) CAN create into the closed space", async () => {
    const out = await docCreate.handler(ctxFor(user(GRANTEE), { allowTransact: true }), {
      title: "grantee entry",
      collection_id: C_CLOSED,
    });
    expect(out.collection_id).toBe(C_CLOSED);
  });

  it("a delegated agent places as its delegator — closed space allowed via the delegator's membership", async () => {
    const out = await docCreate.handler(ctxFor(agent(OTHER), { allowTransact: true }), {
      title: "delegated entry",
      collection_id: C_CLOSED,
    });
    expect(out.collection_id).toBe(C_CLOSED);
  });

  it("a non-member user CAN create into an open space (Org baseline)", async () => {
    const out = await docCreate.handler(ctxFor(user(OUTSIDER), { allowTransact: true }), {
      title: "open entry",
      collection_id: C_OPEN,
    });
    expect(out.collection_id).toBe(C_OPEN);
  });

  it("root creates skip the placement gate entirely", async () => {
    const out = await docCreate.handler(ctxFor(user(OUTSIDER), { allowTransact: true }), {
      title: "root entry",
    });
    expect(out.collection_id).toBeNull();
  });
});

// ── doc.move bucket-transition regime (ADR 0040 §7 — Step-8 branch) ───────
//
// Step 6's blanket same-bucket-only rule (Codex Step-6 review HIGH 2)
// is REPLACED: a move that changes the doc's ceiling bucket is now an
// explicit, audited ACL transition — administer authority on the
// source + `canPlaceIn` standing in the destination + a REQUIRED
// `acl_policy` (the "never silent" rail). The wiring pins here cover
// the seam each arm reaches the resolver through; the full transition
// matrix (policies, dropped-grant preimages, anomaly arms, the
// owner-tier/standing MUST-FIX pin) lives in `../doc/move.unit.test.ts`.

describe("doc.move bucket-transition regime", () => {
  it("closed-space doc → root (the Step-6 widening fear) is never silent: 400 without acl_policy, lands with it", async () => {
    const before = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .where("id", "=", D_FOREIGN)
      .executeTakeFirst();
    let thrown: unknown;
    try {
      await docMove.handler(ctxFor(user(OTHER)), { doc_id: D_FOREIGN, new_collection_id: null });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const after = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .selectAll()
      .where("id", "=", D_FOREIGN)
      .executeTakeFirst();
    expect(after).toEqual(before);

    // With the explicit policy, the creator's administer + the legacy
    // destination (always placeable) carry the widening — audited.
    const out = await docMove.handler(ctxFor(user(OTHER)), {
      doc_id: D_FOREIGN,
      new_collection_id: null,
      acl_policy: "keep_grants",
    });
    expect(out.new_collection_id).toBeNull();
    expect(out.acl_transition?.policy).toBe("keep_grants");
    expect(out.acl_transition?.before_space_id).toBe(S_CLOSED);
    expect(out.acl_transition?.after_space_id).toBeNull();
  });

  it("legacy doc → closed-space collection is denied for a non-member (no administer — authority precedes the policy rail)", async () => {
    await expectAclDeny(
      () =>
        docMove.handler(ctxFor(user(OUTSIDER)), { doc_id: D_LEGACY, new_collection_id: C_CLOSED }),
      D_LEGACY,
    );
  });

  it("legacy doc → closed-space collection: administer + membership cross WITH a policy (was Step-6 denied)", async () => {
    const out = await docMove.handler(ctxFor(user(OTHER)), {
      doc_id: D_LEGACY,
      new_collection_id: C_CLOSED,
      acl_policy: "adopt_baseline",
    });
    expect(out.new_collection_id).toBe(C_CLOSED);
    expect(out.acl_transition?.before_space_id).toBeNull();
    expect(out.acl_transition?.after_space_id).toBe(S_CLOSED);
  });

  it("closed-space doc → a DIFFERENT space's collection re-homes with a policy (open-space baseline standing)", async () => {
    const out = await docMove.handler(ctxFor(user(OTHER)), {
      doc_id: D_FOREIGN,
      new_collection_id: C_OPEN,
      acl_policy: "keep_grants",
    });
    expect(out.acl_transition?.before_space_id).toBe(S_CLOSED);
    expect(out.acl_transition?.after_space_id).toBe(S_OPEN);
  });

  it("same-space re-parent is allowed for a member (same bucket — no policy, no transition echo)", async () => {
    const out = await docMove.handler(ctxFor(user(OTHER)), {
      doc_id: D_FOREIGN,
      new_collection_id: C_CLOSED2,
    });
    expect(out.new_collection_id).toBe(C_CLOSED2);
    expect(out.acl_transition).toBeUndefined();
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["collection_id"])
      .where("id", "=", D_FOREIGN)
      .executeTakeFirst();
    expect(row?.collection_id).toBe(C_CLOSED2);
  });

  it("legacy → legacy (root re-seat) stays allowed (same bucket — no policy, no transition echo)", async () => {
    const out = await docMove.handler(ctxFor(user(OUTSIDER)), {
      doc_id: D_LEGACY,
      new_collection_id: null,
    });
    expect(out.new_collection_id).toBeNull();
    expect(out.acl_transition).toBeUndefined();
  });

  it("an anomaly-placed doc is movable OUT by its creator — the named repair verb (dangling ref → before_space_id null)", async () => {
    const out = await docMove.handler(ctxFor(user(OTHER)), {
      doc_id: D_ANOMALY,
      new_collection_id: null,
      acl_policy: "keep_grants",
    });
    expect(out.new_collection_id).toBeNull();
    // C_DANGLING's space ref points at a spaces row that never
    // existed — the honest binding is null, not a guess.
    expect(out.acl_transition?.before_space_id).toBeNull();
    expect(out.acl_transition?.after_space_id).toBeNull();
  });
});
