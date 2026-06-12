/**
 * Ceiling resolver matrix (ADR 0040 Step 6).
 *
 * Every cell of `who-can-read(X)` against a real SQLite seeded
 * directly (no capability writes Spaces/grants until Step 7/8 — the
 * machinery-before-data posture means direct seeding IS the test
 * substrate, same as the gate's synthetic delegated principals).
 *
 * Subjects × placements covered:
 *   - workspace member with no Space ties (legacy + open baselines)
 *   - Space members (closed + private spaces)
 *   - the creator (implicit permanent owner — every placement)
 *   - doc-grantee (crosses 'private' mode), space-grantee/guest
 *     (baseline-tier — must NOT cross 'private' mode)
 *   - non-delegated agent (own grants; NO open-space baseline)
 *   - delegated agent (delegator's identity; own agent grants IGNORED)
 *   - anomalies fail closed: dangling collection ref, dangling space
 *     ref, soft-deleted space
 *   - soft-deleted collections still BIND (restore-path semantics)
 */

import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  DOCS_DDL,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import { PermissionDeniedError } from "@editorzero/errors";
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
import type { AgentPrincipal, UserPrincipal } from "@editorzero/principal";
import type { AccessMode, GrantRole, SpaceType } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDocReadResolver } from "./ceiling";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const MEMBER_CLOSED = UserId("018f0000-0000-7000-8000-0000000000a2");
const MEMBER_PRIVATE = UserId("018f0000-0000-7000-8000-0000000000a3");
const OUTSIDER = UserId("018f0000-0000-7000-8000-0000000000a4");
const DOC_GRANTEE = UserId("018f0000-0000-7000-8000-0000000000a5");
const SPACE_GRANTEE = UserId("018f0000-0000-7000-8000-0000000000a6");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");
const ADMIN_USER = UserId("018f0000-0000-7000-8000-0000000000a8");
const OWNER_GRANTEE = UserId("018f0000-0000-7000-8000-0000000000a9");
const GUEST_OWNER_GRANTEE = UserId("018f0000-0000-7000-8000-0000000000aa");
const SPACE_OWNER_MEMBER = UserId("018f0000-0000-7000-8000-0000000000ab");
const SPACE_OWNER_GRANTEE = UserId("018f0000-0000-7000-8000-0000000000ac");

const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

const S_OPEN = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const S_PRIVATE = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e5");
const S_MISSING = SpaceId("018f0000-0000-7000-8000-0000000000e9");

const C_OPEN = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const C_CLOSED = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const C_PRIVATE = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const C_LEGACY = CollectionId("018f0000-0000-7000-8000-0000000000c4");
const C_TRASHED_SPACE = CollectionId("018f0000-0000-7000-8000-0000000000c5");
const C_DANGLING_SPACE = CollectionId("018f0000-0000-7000-8000-0000000000c6");
const C_TRASHED = CollectionId("018f0000-0000-7000-8000-0000000000c7");
const C_PERSONAL = CollectionId("018f0000-0000-7000-8000-0000000000c8");
const C_MISSING = CollectionId("018f0000-0000-7000-8000-0000000000c9");

const D_ROOT = DocId("018f0000-0000-7000-8000-0000000000d1");
const D_LEGACY = DocId("018f0000-0000-7000-8000-0000000000d2");
const D_OPEN = DocId("018f0000-0000-7000-8000-0000000000d3");
const D_CLOSED = DocId("018f0000-0000-7000-8000-0000000000d4");
const D_PRIVATE_SPACE = DocId("018f0000-0000-7000-8000-0000000000d5");
const D_PRIVATE_MODE = DocId("018f0000-0000-7000-8000-0000000000d6");
const D_PRIVATE_IN_CLOSED = DocId("018f0000-0000-7000-8000-0000000000d7");
const D_DANGLING_COL = DocId("018f0000-0000-7000-8000-0000000000d8");
const D_DANGLING_SPACE = DocId("018f0000-0000-7000-8000-0000000000d9");
const D_TRASHED_SPACE = DocId("018f0000-0000-7000-8000-0000000000da");
const D_IN_TRASHED_COL = DocId("018f0000-0000-7000-8000-0000000000db");
const D_PERSONAL = DocId("018f0000-0000-7000-8000-0000000000dc");

let driver: SqliteDriver;
let db: TenantScopedDb;

/** Doc rows as the handlers pass them to the resolver. */
const DOC_ROWS: Record<
  string,
  { id: DocId; created_by: UserId; access_mode: AccessMode; collection_id: CollectionId | null }
> = {
  [D_ROOT]: { id: D_ROOT, created_by: CREATOR, access_mode: "space", collection_id: null },
  [D_LEGACY]: { id: D_LEGACY, created_by: CREATOR, access_mode: "space", collection_id: C_LEGACY },
  [D_OPEN]: { id: D_OPEN, created_by: CREATOR, access_mode: "space", collection_id: C_OPEN },
  [D_CLOSED]: { id: D_CLOSED, created_by: CREATOR, access_mode: "space", collection_id: C_CLOSED },
  [D_PRIVATE_SPACE]: {
    id: D_PRIVATE_SPACE,
    created_by: CREATOR,
    access_mode: "space",
    collection_id: C_PRIVATE,
  },
  [D_PRIVATE_MODE]: {
    id: D_PRIVATE_MODE,
    created_by: CREATOR,
    access_mode: "private",
    collection_id: C_OPEN,
  },
  [D_PRIVATE_IN_CLOSED]: {
    id: D_PRIVATE_IN_CLOSED,
    created_by: CREATOR,
    access_mode: "private",
    collection_id: C_CLOSED,
  },
  [D_DANGLING_COL]: {
    id: D_DANGLING_COL,
    created_by: CREATOR,
    access_mode: "space",
    collection_id: C_MISSING,
  },
  [D_DANGLING_SPACE]: {
    id: D_DANGLING_SPACE,
    created_by: CREATOR,
    access_mode: "space",
    collection_id: C_DANGLING_SPACE,
  },
  [D_TRASHED_SPACE]: {
    id: D_TRASHED_SPACE,
    created_by: CREATOR,
    access_mode: "space",
    collection_id: C_TRASHED_SPACE,
  },
  [D_IN_TRASHED_COL]: {
    id: D_IN_TRASHED_COL,
    created_by: CREATOR,
    access_mode: "space",
    collection_id: C_TRASHED,
  },
  [D_PERSONAL]: {
    id: D_PERSONAL,
    created_by: PERSONAL_OWNER,
    access_mode: "space",
    collection_id: C_PERSONAL,
  },
};

async function seedSpace(
  id: SpaceId,
  type: SpaceType,
  deleted_at: number | null = null,
  personalOwner: UserId | null = null,
) {
  await db
    .insertInto("spaces")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      kind: personalOwner === null ? "team" : "personal",
      type,
      owner_user_id: personalOwner,
      name: `space-${id.slice(-2)}`,
      slug: `space-${id.slice(-2)}`,
      baseline_access: "view",
      created_by: CREATOR,
      created_at: 1,
      updated_at: 1,
      deleted_at,
    })
    .execute();
}

async function seedCollection(
  id: CollectionId,
  space_id: SpaceId | null,
  deleted_at: number | null = null,
) {
  await db
    .insertInto("collections")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      parent_id: null,
      space_id,
      title: `col-${id.slice(-2)}`,
      slug: `col-${id.slice(-2)}`,
      order_key: `a${id.slice(-2)}`,
      created_by: CREATOR,
      created_at: 1,
      updated_at: 1,
      deleted_at,
    })
    .execute();
}

async function seedMember(space_id: SpaceId, user_id: UserId, role: GrantRole = "view") {
  await db
    .insertInto("space_members")
    .values({ workspace_id: WORKSPACE_A, space_id, user_id, role, created_at: 1, updated_at: 1 })
    .execute();
}

let grantSeq = 0;
async function seedGrant(params: {
  resource_kind: "space" | "doc";
  resource_id: string;
  subject_kind: "user" | "agent";
  subject_id: string;
  is_guest?: 0 | 1;
  role?: GrantRole;
}) {
  grantSeq += 1;
  await db
    .insertInto("grants")
    .values({
      id: GrantId(`018f0000-0000-7000-8000-0000000000f${grantSeq.toString(16)}`),
      workspace_id: WORKSPACE_A,
      resource_kind: params.resource_kind,
      resource_id: params.resource_id,
      subject_kind: params.subject_kind,
      subject_id: params.subject_id,
      role: params.role ?? "view",
      is_guest: params.is_guest ?? 0,
      created_by: CREATOR,
      created_at: 1,
    })
    .execute();
}

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  driver.exec(DOCS_DDL);
  db = driver.scoped(WORKSPACE_A);
  grantSeq = 0;

  await seedSpace(S_OPEN, "open");
  await seedSpace(S_CLOSED, "closed");
  await seedSpace(S_PRIVATE, "private");
  await seedSpace(S_TRASHED, "open", 99);
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);

  await seedCollection(C_OPEN, S_OPEN);
  await seedCollection(C_CLOSED, S_CLOSED);
  await seedCollection(C_PRIVATE, S_PRIVATE);
  await seedCollection(C_LEGACY, null);
  await seedCollection(C_TRASHED_SPACE, S_TRASHED);
  await seedCollection(C_DANGLING_SPACE, S_MISSING);
  await seedCollection(C_TRASHED, S_CLOSED, 5);
  await seedCollection(C_PERSONAL, S_PERSONAL);

  await seedMember(S_CLOSED, MEMBER_CLOSED);
  await seedMember(S_PRIVATE, MEMBER_PRIVATE);
  await seedMember(S_CLOSED, SPACE_OWNER_MEMBER, "owner");

  await seedGrant({
    resource_kind: "doc",
    resource_id: D_PRIVATE_MODE,
    subject_kind: "user",
    subject_id: DOC_GRANTEE,
  });
  await seedGrant({
    resource_kind: "space",
    resource_id: S_CLOSED,
    subject_kind: "user",
    subject_id: SPACE_GRANTEE,
    is_guest: 1,
  });
  await seedGrant({
    resource_kind: "doc",
    resource_id: D_PRIVATE_MODE,
    subject_kind: "agent",
    subject_id: BOT,
  });
  // Authority-ladder fixtures (Step 8): an owner-role doc grant, an
  // owner-role GUEST doc grant (must confer nothing), and an
  // owner-role space grant.
  await seedGrant({
    resource_kind: "doc",
    resource_id: D_PRIVATE_MODE,
    subject_kind: "user",
    subject_id: OWNER_GRANTEE,
    role: "owner",
  });
  await seedGrant({
    resource_kind: "doc",
    resource_id: D_CLOSED,
    subject_kind: "user",
    subject_id: GUEST_OWNER_GRANTEE,
    role: "owner",
    is_guest: 1,
  });
  await seedGrant({
    resource_kind: "space",
    resource_id: S_CLOSED,
    subject_kind: "user",
    subject_id: SPACE_OWNER_GRANTEE,
    role: "owner",
  });
});

afterEach(async () => {
  await driver.close();
});

function user(id: UserId, roles: UserPrincipal["roles"] = ["member"]): UserPrincipal {
  return {
    kind: "user",
    id,
    workspace_id: WORKSPACE_A,
    roles,
    session_id: null,
    token_id: null,
  };
}

function bot(acting_as?: UserId): AgentPrincipal {
  return {
    kind: "agent",
    id: BOT,
    workspace_id: WORKSPACE_A,
    owner_user_id: CREATOR,
    scopes: ["doc:read"],
    token_id: BOT_TOKEN,
    token_kind: acting_as === undefined ? "api-key" : "agent-auth",
    ...(acting_as !== undefined && { acting_as }),
  };
}

/** Assert the subject's full readable set in one shot. */
async function expectReadable(
  principal: UserPrincipal | AgentPrincipal,
  expected: Record<string, boolean>,
) {
  const acl = await loadDocReadResolver(db, principal);
  const actual = Object.fromEntries(
    Object.entries(DOC_ROWS).map(([id, row]) => [id, acl.canRead(row)]),
  );
  expect(actual).toEqual(expected);
}

describe("ceiling matrix — user subjects", () => {
  it("workspace member with no Space ties: legacy + open baselines only", async () => {
    await expectReadable(user(OUTSIDER), {
      [D_ROOT]: true, // root doc — NULL-space legacy baseline
      [D_LEGACY]: true, // unspaced collection — legacy baseline
      [D_OPEN]: true, // open-space Org baseline
      [D_CLOSED]: false,
      [D_PRIVATE_SPACE]: false,
      [D_PRIVATE_MODE]: false,
      [D_PRIVATE_IN_CLOSED]: false,
      [D_DANGLING_COL]: false, // anomaly — fail closed
      [D_DANGLING_SPACE]: false, // anomaly — fail closed
      [D_TRASHED_SPACE]: false, // soft-deleted space — fail closed
      [D_IN_TRASHED_COL]: false, // binds to S_CLOSED; not a member
      [D_PERSONAL]: false,
    });
  });

  it("the creator reads EVERYTHING they created — implicit permanent owner beats every other rule", async () => {
    await expectReadable(user(CREATOR), {
      [D_ROOT]: true,
      [D_LEGACY]: true,
      [D_OPEN]: true,
      [D_CLOSED]: true,
      [D_PRIVATE_SPACE]: true,
      [D_PRIVATE_MODE]: true,
      [D_PRIVATE_IN_CLOSED]: true,
      [D_DANGLING_COL]: true, // anomaly fail-closed never locks out the creator
      [D_DANGLING_SPACE]: true,
      [D_TRASHED_SPACE]: true,
      [D_IN_TRASHED_COL]: true,
      [D_PERSONAL]: false,
    });
  });

  it("a closed-space member reads its docs — including via a soft-deleted collection (binding survives trash)", async () => {
    await expectReadable(user(MEMBER_CLOSED), {
      [D_ROOT]: true,
      [D_LEGACY]: true,
      [D_OPEN]: true,
      [D_CLOSED]: true, // membership
      [D_PRIVATE_SPACE]: false,
      [D_PRIVATE_MODE]: false,
      [D_PRIVATE_IN_CLOSED]: false, // membership is baseline-tier; private cuts it
      [D_DANGLING_COL]: false,
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false,
      [D_IN_TRASHED_COL]: true, // C_TRASHED still binds to S_CLOSED
      [D_PERSONAL]: false,
    });
  });

  it("a private-space member reads its 'space'-mode docs; private SPACE ≠ private MODE", async () => {
    await expectReadable(user(MEMBER_PRIVATE), {
      [D_ROOT]: true,
      [D_LEGACY]: true,
      [D_OPEN]: true,
      [D_CLOSED]: false,
      [D_PRIVATE_SPACE]: true, // membership in the private space
      [D_PRIVATE_MODE]: false,
      [D_PRIVATE_IN_CLOSED]: false,
      [D_DANGLING_COL]: false,
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false,
      [D_IN_TRASHED_COL]: false,
      [D_PERSONAL]: false,
    });
  });

  it("a doc grant crosses 'private' mode; a space grant (guest) does NOT", async () => {
    await expectReadable(user(DOC_GRANTEE), {
      [D_ROOT]: true,
      [D_LEGACY]: true,
      [D_OPEN]: true,
      [D_CLOSED]: false,
      [D_PRIVATE_SPACE]: false,
      [D_PRIVATE_MODE]: true, // explicit doc grant — the one door into private mode
      [D_PRIVATE_IN_CLOSED]: false,
      [D_DANGLING_COL]: false,
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false,
      [D_IN_TRASHED_COL]: false,
      [D_PERSONAL]: false,
    });
    await expectReadable(user(SPACE_GRANTEE), {
      [D_ROOT]: true,
      [D_LEGACY]: true,
      [D_OPEN]: true,
      [D_CLOSED]: true, // guest space grant on S_CLOSED
      [D_PRIVATE_SPACE]: false,
      [D_PRIVATE_MODE]: false,
      [D_PRIVATE_IN_CLOSED]: false, // space grant is baseline-tier — private cuts it
      [D_DANGLING_COL]: false,
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false,
      [D_IN_TRASHED_COL]: true, // S_CLOSED binding via trashed collection
      [D_PERSONAL]: false,
    });
  });
});

describe("ceiling matrix — agent subjects", () => {
  it("a non-delegated agent: own grants + legacy baselines, NO open-space baseline (agents are not Org members)", async () => {
    await expectReadable(bot(), {
      [D_ROOT]: true, // legacy baseline applies to every workspace principal
      [D_LEGACY]: true,
      [D_OPEN]: false, // open-space baseline is user-only
      [D_CLOSED]: false,
      [D_PRIVATE_SPACE]: false,
      [D_PRIVATE_MODE]: true, // its own agent-subject doc grant
      [D_PRIVATE_IN_CLOSED]: false,
      [D_DANGLING_COL]: false,
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false,
      [D_IN_TRASHED_COL]: false,
      [D_PERSONAL]: false,
    });
  });

  it("a delegated agent evaluates as its DELEGATOR — gains the delegator's reach, loses its own agent grants", async () => {
    await expectReadable(bot(MEMBER_CLOSED), {
      [D_ROOT]: true,
      [D_LEGACY]: true,
      [D_OPEN]: true, // delegator is an Org member — open baseline applies
      [D_CLOSED]: true, // delegator's membership
      [D_PRIVATE_SPACE]: false,
      // The agent's OWN doc grant must NOT apply while delegated:
      // agent ∪ delegator would exceed the human it acts for.
      [D_PRIVATE_MODE]: false,
      [D_PRIVATE_IN_CLOSED]: false,
      [D_DANGLING_COL]: false,
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false,
      [D_IN_TRASHED_COL]: true,
      [D_PERSONAL]: false,
    });
  });
});

// ── Placement authority (doc.create / doc.move write gates) ───────────────
//
// `canPlaceIn` is the BASELINE-reach term of the read union ONLY:
// membership, space grant, open-space user baseline. `created_by` and
// doc grants are doc-scoped and there is no doc yet at placement time
// — the matrix proves they confer nothing here (CREATOR's row equals
// OUTSIDER's). Descriptive keys so a failing cell names its placement.

const PLACEMENTS: Record<string, CollectionId | null> = {
  root: null,
  "legacy-col": C_LEGACY,
  "open-col": C_OPEN,
  "closed-col": C_CLOSED,
  "private-col": C_PRIVATE,
  "trashed-col-binds-closed": C_TRASHED,
  "trashed-space-col": C_TRASHED_SPACE,
  "dangling-space-col": C_DANGLING_SPACE,
  "missing-col": C_MISSING,
  "personal-col": C_PERSONAL,
};

async function expectPlaceable(
  principal: UserPrincipal | AgentPrincipal,
  expected: Record<string, boolean>,
) {
  const acl = await loadDocReadResolver(db, principal);
  const actual = Object.fromEntries(
    Object.entries(PLACEMENTS).map(([key, cid]) => [key, acl.canPlaceIn(cid)]),
  );
  expect(actual).toEqual(expected);
}

describe("placement authority — placementOf / canPlaceIn", () => {
  it("placementOf resolves buckets subject-independently (trash ≠ unbind; dangling = anomaly)", async () => {
    const acl = await loadDocReadResolver(db, user(OUTSIDER));
    expect(acl.placementOf(null)).toEqual({ kind: "legacy" });
    expect(acl.placementOf(C_LEGACY)).toEqual({ kind: "legacy" });
    expect(acl.placementOf(C_OPEN)).toEqual({ kind: "space", space_id: S_OPEN });
    expect(acl.placementOf(C_TRASHED)).toEqual({ kind: "space", space_id: S_CLOSED });
    expect(acl.placementOf(C_PERSONAL)).toEqual({ kind: "space", space_id: S_PERSONAL });
    expect(acl.placementOf(C_MISSING)).toEqual({ kind: "anomaly" });
    expect(acl.placementOf(C_DANGLING_SPACE)).toEqual({ kind: "anomaly" });
    expect(acl.placementOf(C_TRASHED_SPACE)).toEqual({ kind: "anomaly" });
  });

  it("a tie-less member and the CREATOR place identically — creating docs grants no placement authority", async () => {
    const baselineOnly = {
      root: true,
      "legacy-col": true,
      "open-col": true, // open-space Org baseline (user)
      "closed-col": false,
      "private-col": false,
      "trashed-col-binds-closed": false,
      "trashed-space-col": false,
      "dangling-space-col": false,
      "missing-col": false,
      "personal-col": false,
    };
    await expectPlaceable(user(OUTSIDER), baselineOnly);
    // CREATOR authored every doc in the matrix and still cannot
    // place INTO spaces they don't reach — created_by is doc-scoped.
    await expectPlaceable(user(CREATOR), baselineOnly);
  });

  it("membership and space grants open their space — including via a soft-deleted collection", async () => {
    const closedReach = {
      root: true,
      "legacy-col": true,
      "open-col": true,
      "closed-col": true,
      "private-col": false,
      "trashed-col-binds-closed": true, // binds S_CLOSED; handler 404s first
      "trashed-space-col": false,
      "dangling-space-col": false,
      "missing-col": false,
      "personal-col": false,
    };
    await expectPlaceable(user(MEMBER_CLOSED), closedReach);
    await expectPlaceable(user(SPACE_GRANTEE), closedReach);
  });

  it("a non-delegated agent has NO open-space baseline; a delegated one places as its delegator", async () => {
    await expectPlaceable(bot(), {
      root: true,
      "legacy-col": true,
      "open-col": false, // open baseline is user-only
      "closed-col": false,
      "private-col": false,
      "trashed-col-binds-closed": false,
      "trashed-space-col": false,
      "dangling-space-col": false,
      "missing-col": false,
      "personal-col": false,
    });
    await expectPlaceable(bot(MEMBER_CLOSED), {
      root: true,
      "legacy-col": true,
      "open-col": true, // delegator's user baseline
      "closed-col": true, // delegator's membership
      "private-col": false,
      "trashed-col-binds-closed": true,
      "trashed-space-col": false,
      "dangling-space-col": false,
      "missing-col": false,
      "personal-col": false,
    });
  });

  it("assertCanPlaceIn throws acl_deny scoped to the COLLECTION", async () => {
    const acl = await loadDocReadResolver(db, user(OUTSIDER));
    let thrown: unknown;
    try {
      acl.assertCanPlaceIn(C_CLOSED);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PermissionDeniedError);
    if (thrown instanceof PermissionDeniedError) {
      expect(thrown.reason).toEqual({ kind: "acl_deny", scope: { collection_id: C_CLOSED } });
    }
    expect(() => acl.assertCanPlaceIn(C_OPEN)).not.toThrow();
  });
});

describe("assertCanRead — the F88 deny projection", () => {
  it("throws PermissionDeniedError with acl_deny + the doc id on a ceiling miss", async () => {
    const acl = await loadDocReadResolver(db, user(OUTSIDER));
    const row = DOC_ROWS[D_CLOSED];
    if (row === undefined) throw new Error("fixture missing");
    let thrown: unknown;
    try {
      acl.assertCanRead(row);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PermissionDeniedError);
    if (thrown instanceof PermissionDeniedError) {
      expect(thrown.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_CLOSED } });
    }
  });

  it("does not throw on a readable doc", async () => {
    const acl = await loadDocReadResolver(db, user(OUTSIDER));
    const row = DOC_ROWS[D_ROOT];
    if (row === undefined) throw new Error("fixture missing");
    expect(() => acl.assertCanRead(row)).not.toThrow();
  });
});

// ── Personal-space owner reach (the structural owner term) ────────────────
//
// A personal space has NO space_members row by necessity of the model
// (the CHECK pins owner_user_id; membership rows are a seeding
// convention). The owner term in baselineReach is what lets the
// signup-seeded Personal space serve its owner at all — without it the
// owner could neither read 'space'-mode docs in it nor place new docs.

describe("personal-space owner reach", () => {
  it("the owner reads + places in their personal space with no membership row", async () => {
    const acl = await loadDocReadResolver(db, user(PERSONAL_OWNER));
    const row = DOC_ROWS[D_PERSONAL];
    if (row === undefined) throw new Error("fixture missing");
    expect(acl.canRead(row)).toBe(true);
    expect(acl.canPlaceIn(C_PERSONAL)).toBe(true);
    expect(acl.hasBaselineReach(S_PERSONAL)).toBe(true);
  });

  it("nobody else reaches it — not even a workspace admin", async () => {
    for (const principal of [user(OUTSIDER), user(ADMIN_USER, ["admin"]), bot()]) {
      const acl = await loadDocReadResolver(db, principal);
      expect(acl.canPlaceIn(C_PERSONAL)).toBe(false);
      expect(acl.hasBaselineReach(S_PERSONAL)).toBe(false);
    }
  });
});

// ── Granting authority (ADR 0040 Step 8) ──────────────────────────────────
//
// The ladder: doc owner-tier (created_by / non-guest owner-role doc
// grant) → by placement: space owner-tier (personal = owner_user_id
// ONLY; team = owner-role membership / non-guest owner-role space
// grant / workspace owner-admin backstop), legacy = admin backstop,
// anomaly = fail closed. Guest grants never confer authority. The
// admin backstop is USER-principal-only (the resolver cannot see a
// delegator's workspace roles — fail closed for agents).

async function expectAdministerable(
  principal: UserPrincipal | AgentPrincipal,
  expected: Record<string, boolean>,
) {
  const acl = await loadDocReadResolver(db, principal);
  const actual = Object.fromEntries(
    Object.entries(DOC_ROWS).map(([id, row]) => [id, acl.canAdministerDoc(row)]),
  );
  expect(actual).toEqual(expected);
}

describe("granting authority — canAdministerDoc", () => {
  it("the creator administers every doc they created, anomalies included; never the personal doc of another", async () => {
    await expectAdministerable(user(CREATOR), {
      [D_ROOT]: true,
      [D_LEGACY]: true,
      [D_OPEN]: true,
      [D_CLOSED]: true,
      [D_PRIVATE_SPACE]: true,
      [D_PRIVATE_MODE]: true,
      [D_PRIVATE_IN_CLOSED]: true,
      [D_DANGLING_COL]: true, // doc owner-tier beats anomaly fail-closed
      [D_DANGLING_SPACE]: true,
      [D_TRASHED_SPACE]: true,
      [D_IN_TRASHED_COL]: true,
      [D_PERSONAL]: false, // created_by is PERSONAL_OWNER, not CREATOR
    });
  });

  it("a tie-less member administers nothing", async () => {
    await expectAdministerable(user(OUTSIDER), {
      [D_ROOT]: false,
      [D_LEGACY]: false,
      [D_OPEN]: false,
      [D_CLOSED]: false,
      [D_PRIVATE_SPACE]: false,
      [D_PRIVATE_MODE]: false,
      [D_PRIVATE_IN_CLOSED]: false,
      [D_DANGLING_COL]: false,
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false,
      [D_IN_TRASHED_COL]: false,
      [D_PERSONAL]: false,
    });
  });

  it("a workspace admin administers legacy + team-space docs; NEVER personal docs, NEVER anomalies", async () => {
    await expectAdministerable(user(ADMIN_USER, ["admin"]), {
      [D_ROOT]: true, // legacy — admin backstop
      [D_LEGACY]: true,
      [D_OPEN]: true, // team space — admin backstop via space owner-tier
      [D_CLOSED]: true,
      [D_PRIVATE_SPACE]: true,
      // private MODE cuts baseline READS, not team-space ADMINISTRATION
      // (the privacy-from-admins pin is the personal space, below).
      [D_PRIVATE_MODE]: true,
      [D_PRIVATE_IN_CLOSED]: true,
      [D_DANGLING_COL]: false, // anomaly — fail closed, admin included
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false, // soft-deleted space = anomaly placement
      [D_IN_TRASHED_COL]: true, // binds S_CLOSED (team) — admin backstop
      [D_PERSONAL]: false, // the scenario-3 pin: personal stays personal
    });
  });

  it("an owner-role doc grant confers authority on exactly that doc; a guest owner-role grant confers NOTHING", async () => {
    await expectAdministerable(user(OWNER_GRANTEE), {
      [D_ROOT]: false,
      [D_LEGACY]: false,
      [D_OPEN]: false,
      [D_CLOSED]: false,
      [D_PRIVATE_SPACE]: false,
      [D_PRIVATE_MODE]: true, // non-guest owner-role doc grant
      [D_PRIVATE_IN_CLOSED]: false,
      [D_DANGLING_COL]: false,
      [D_DANGLING_SPACE]: false,
      [D_TRASHED_SPACE]: false,
      [D_IN_TRASHED_COL]: false,
      [D_PERSONAL]: false,
    });
    const guestAcl = await loadDocReadResolver(db, user(GUEST_OWNER_GRANTEE));
    const closedRow = DOC_ROWS[D_CLOSED];
    if (closedRow === undefined) throw new Error("fixture missing");
    // The guest READS the doc (grants read in both modes)...
    expect(guestAcl.canRead(closedRow)).toBe(true);
    // ...but an owner-ROLE guest grant still administers nothing
    // (re-share-proof — bounded blast radius, scenario 7).
    expect(guestAcl.canAdministerDoc(closedRow)).toBe(false);
  });

  it("space owner-tier (owner membership OR non-guest owner space grant) administers the space's docs", async () => {
    for (const subject of [SPACE_OWNER_MEMBER, SPACE_OWNER_GRANTEE]) {
      await expectAdministerable(user(subject), {
        [D_ROOT]: false,
        [D_LEGACY]: false,
        [D_OPEN]: false,
        [D_CLOSED]: true, // S_CLOSED owner-tier
        [D_PRIVATE_SPACE]: false,
        [D_PRIVATE_MODE]: false,
        [D_PRIVATE_IN_CLOSED]: true, // same space; mode cuts reads, not administration
        [D_DANGLING_COL]: false,
        [D_DANGLING_SPACE]: false,
        [D_TRASHED_SPACE]: false,
        [D_IN_TRASHED_COL]: true, // trashed collection still binds S_CLOSED
        [D_PERSONAL]: false,
      });
    }
  });

  it("delegated agents collapse to the delegator's identity terms but NEVER the admin backstop", async () => {
    // As the CREATOR's delegate: every created_by term applies.
    const asCreator = await loadDocReadResolver(db, bot(CREATOR));
    const rootRow = DOC_ROWS[D_ROOT];
    if (rootRow === undefined) throw new Error("fixture missing");
    expect(asCreator.canAdministerDoc(rootRow)).toBe(true);
    // As the ADMIN's delegate: the backstop must NOT apply (the
    // resolver cannot see delegator roles — fail closed).
    const asAdmin = await loadDocReadResolver(db, bot(ADMIN_USER));
    expect(asAdmin.canAdministerDoc(rootRow)).toBe(false);
    // Non-delegated agent: nothing here (its only grant is view-role).
    const asSelf = await loadDocReadResolver(db, bot());
    expect(asSelf.canAdministerDoc(rootRow)).toBe(false);
  });
});

describe("granting authority — canAdministerSpace", () => {
  it("personal spaces: owner_user_id ONLY — admins and owner-role grants excluded", async () => {
    const owner = await loadDocReadResolver(db, user(PERSONAL_OWNER));
    expect(owner.canAdministerSpace(S_PERSONAL)).toBe(true);
    const admin = await loadDocReadResolver(db, user(ADMIN_USER, ["admin"]));
    expect(admin.canAdministerSpace(S_PERSONAL)).toBe(false);
  });

  it("team spaces: owner membership, owner space grant, or the admin backstop", async () => {
    for (const [principal, expected] of [
      [user(SPACE_OWNER_MEMBER), true],
      [user(SPACE_OWNER_GRANTEE), true],
      [user(ADMIN_USER, ["admin"]), true],
      [user(ADMIN_USER, ["owner"]), true],
      [user(MEMBER_CLOSED), false], // view-role membership is not owner-tier
      [user(SPACE_GRANTEE), false], // guest view-role space grant
      [user(OUTSIDER), false],
      [bot(ADMIN_USER), false], // no admin backstop through delegation
    ] as const) {
      const acl = await loadDocReadResolver(db, principal);
      expect(acl.canAdministerSpace(S_CLOSED)).toBe(expected);
    }
  });

  it("missing and soft-deleted spaces are never administerable", async () => {
    const acl = await loadDocReadResolver(db, user(ADMIN_USER, ["admin"]));
    expect(acl.canAdministerSpace(S_MISSING)).toBe(false);
    expect(acl.canAdministerSpace(S_TRASHED)).toBe(false);
    expect(acl.hasBaselineReach(S_MISSING)).toBe(false);
    expect(acl.hasBaselineReach(S_TRASHED)).toBe(false);
  });

  it("assertCanAdministerDoc / assertCanAdministerSpace throw acl_deny scoped to their target", async () => {
    const acl = await loadDocReadResolver(db, user(OUTSIDER));
    const row = DOC_ROWS[D_CLOSED];
    if (row === undefined) throw new Error("fixture missing");
    let docErr: unknown;
    try {
      acl.assertCanAdministerDoc(row);
    } catch (err) {
      docErr = err;
    }
    expect(docErr).toBeInstanceOf(PermissionDeniedError);
    if (docErr instanceof PermissionDeniedError) {
      expect(docErr.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_CLOSED } });
    }
    let spaceErr: unknown;
    try {
      acl.assertCanAdministerSpace(S_CLOSED);
    } catch (err) {
      spaceErr = err;
    }
    expect(spaceErr).toBeInstanceOf(PermissionDeniedError);
    if (spaceErr instanceof PermissionDeniedError) {
      expect(spaceErr.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_CLOSED } });
    }
    const creatorAcl = await loadDocReadResolver(db, user(CREATOR));
    expect(() => creatorAcl.assertCanAdministerDoc(row)).not.toThrow();
  });
});
