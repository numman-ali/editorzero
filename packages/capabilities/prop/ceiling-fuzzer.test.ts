/**
 * Ceiling isolation fuzzer (ADR 0040 Step 6; architecture §8.1a's
 * resolver-grade slice).
 *
 * Three properties over randomized two-tenant worlds:
 *
 *   1. **Oracle equality.** For every subject × every doc row, the SQL
 *      resolver (`loadDocReadResolver` — preloads through the
 *      plugin-scoped handle, evaluates in memory) must agree with an
 *      INDEPENDENT in-memory oracle computed straight off the world
 *      model, never touching SQL. The two restate the same ADR
 *      formula, so what this actually proves is the resolver's DATA
 *      PATH: workspace scoping on every preload, subject matching,
 *      lifecycle filters, map-building. A resolver bug that loads a
 *      foreign tenant's grants, drops a deleted_at filter, or matches
 *      `subject_kind` loosely diverges from the oracle here.
 *
 *   2. **H6 — `resource_id` resolves within `workspace_id`.** Grants
 *      tables are polymorphic (no composite FK — ADR 0040 H6), so each
 *      world seeds deliberate cross-tenant garbage: grants in B whose
 *      `resource_id` points at A's docs/spaces, grants in A pointing at
 *      B's. The oracle ignores foreign rows BY CONSTRUCTION (it only
 *      reads A's grant list), so oracle equality fails if the resolver
 *      ever lets a foreign grant row widen a read set. A dedicated
 *      assertion also pins the sharpest case: a subject whose ONLY
 *      grant lives in the foreign tenant reads nothing extra.
 *
 *   3. **Privacy invariant.** Independently of the oracle: a doc in a
 *      private Space (access_mode='space') is readable ONLY by its
 *      creator, that Space's members, its doc-grantees, or that
 *      Space's grantees; an access_mode='private' doc ONLY by creator
 *      + doc-grantees. Asserted as its own loop so an oracle bug
 *      cannot silently bless a privacy hole (defense in depth on the
 *      test itself).
 *
 * Deterministic: seeds 1..ROUNDS, mulberry32 PRNG, fresh in-memory
 * SQLite per round. The ACL-audit-replay property the ADR lists for
 * this step is DEFERRED to Step 7/8 with the acl effect family — no
 * capability can mutate grants/spaces yet, so there is no audit
 * stream to replay (recorded in the ADR's Step-6 amendment).
 */

import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  DOCS_DDL,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
} from "@editorzero/db";
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
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import type { AccessMode, SpaceType } from "@editorzero/scopes";
import { describe, expect, it } from "vitest";

import { type CeilingDocRow, loadDocReadResolver } from "../src/index";

// ── Deterministic PRNG ─────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  const item = arr[Math.floor(rnd() * arr.length)];
  if (item === undefined) throw new Error("pick from empty array");
  return item;
}

function chance(rnd: () => number, p: number): boolean {
  return rnd() < p;
}

/** UUIDv7-shaped deterministic ids: counter in the tail, tag in the head. */
let mintCounter = 0;
function mintUuid(): string {
  mintCounter += 1;
  const tail = mintCounter.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}`;
}

// ── World model (the oracle's substrate — plain data, no SQL) ─────────────

interface WorldSpace {
  id: SpaceId;
  type: SpaceType;
  deleted_at: number | null;
}
interface WorldCollection {
  id: CollectionId;
  space_id: SpaceId | null;
  deleted_at: number | null;
}
interface WorldDoc {
  id: DocId;
  created_by: UserId;
  access_mode: AccessMode;
  collection_id: CollectionId | null;
  deleted_at: number | null;
}
interface WorldGrant {
  resource_kind: "space" | "doc";
  resource_id: string;
  subject_kind: "user" | "agent";
  subject_id: string;
  is_guest: 0 | 1;
}
interface World {
  workspace_id: WorkspaceId;
  users: UserId[];
  agents: AgentId[];
  spaces: WorldSpace[];
  collections: WorldCollection[];
  docs: WorldDoc[];
  members: Array<{ space_id: SpaceId; user_id: UserId }>;
  grants: WorldGrant[];
}

function generateWorld(rnd: () => number, workspace_id: WorkspaceId): World {
  const users = Array.from({ length: 5 }, () => UserId(mintUuid()));
  const agents = Array.from({ length: 2 }, () => AgentId(mintUuid()));

  const spaces: WorldSpace[] = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
    id: SpaceId(mintUuid()),
    type: pick(rnd, ["open", "closed", "private"] as const),
    deleted_at: chance(rnd, 0.15) ? 99 : null,
  }));

  const collections: WorldCollection[] = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({
    id: CollectionId(mintUuid()),
    // null = legacy; 10% dangling space ref (anomaly arm)
    space_id: chance(rnd, 0.25)
      ? null
      : chance(rnd, 0.1)
        ? SpaceId(mintUuid())
        : pick(rnd, spaces).id,
    deleted_at: chance(rnd, 0.1) ? 50 : null,
  }));

  const docs: WorldDoc[] = Array.from({ length: 2 + Math.floor(rnd() * 10) }, () => ({
    id: DocId(mintUuid()),
    created_by: pick(rnd, users),
    access_mode: chance(rnd, 0.25) ? "private" : "space",
    // null = root; 5% dangling collection ref (anomaly arm)
    collection_id: chance(rnd, 0.2)
      ? null
      : chance(rnd, 0.05)
        ? CollectionId(mintUuid())
        : pick(rnd, collections).id,
    deleted_at: chance(rnd, 0.1) ? 70 : null,
  }));

  const members: World["members"] = [];
  for (const space of spaces) {
    for (const user of users) {
      if (chance(rnd, 0.35)) members.push({ space_id: space.id, user_id: user });
    }
  }

  const subjects: Array<{ kind: "user" | "agent"; id: string }> = [
    ...users.map((u) => ({ kind: "user" as const, id: u })),
    ...agents.map((a) => ({ kind: "agent" as const, id: a })),
  ];
  // The grants table's unique edge index forbids duplicate
  // (resource, subject) pairs — dedupe at generation so the model
  // matches what actually seeds.
  const grants: WorldGrant[] = [];
  const seenEdges = new Set<string>();
  for (let i = 0, n = Math.floor(rnd() * 8); i < n; i++) {
    const subject = pick(rnd, subjects);
    const onDoc = chance(rnd, 0.6);
    const resource_id = onDoc ? pick(rnd, docs).id : pick(rnd, spaces).id;
    const key = `${onDoc ? "doc" : "space"}:${resource_id}:${subject.kind}:${subject.id}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    grants.push({
      resource_kind: onDoc ? "doc" : "space",
      resource_id,
      subject_kind: subject.kind,
      subject_id: subject.id,
      is_guest: chance(rnd, 0.4) ? 1 : 0,
    });
  }

  return { workspace_id, users, agents, spaces, collections, docs, members, grants };
}

// ── The oracle — straight off the model, never SQL ─────────────────────────

type Subject = { kind: "user"; id: UserId } | { kind: "agent"; id: AgentId };

function oracleCanRead(world: World, subject: Subject, doc: WorldDoc): boolean {
  const hasDocGrant = world.grants.some(
    (g) =>
      g.resource_kind === "doc" &&
      g.resource_id === doc.id &&
      g.subject_kind === subject.kind &&
      g.subject_id === subject.id,
  );
  if (subject.kind === "user" && doc.created_by === subject.id) return true;
  if (hasDocGrant) return true;
  if (doc.access_mode === "private") return false;

  if (doc.collection_id === null) return true;
  const col = world.collections.find((c) => c.id === doc.collection_id);
  if (col === undefined) return false;
  if (col.space_id === null) return true;
  const spaceId = col.space_id;
  const space = world.spaces.find((s) => s.id === spaceId);
  if (space === undefined || space.deleted_at !== null) return false;

  const hasSpaceGrant = world.grants.some(
    (g) =>
      g.resource_kind === "space" &&
      g.resource_id === spaceId &&
      g.subject_kind === subject.kind &&
      g.subject_id === subject.id,
  );
  if (hasSpaceGrant) return true;
  if (subject.kind === "user") {
    if (world.members.some((m) => m.space_id === spaceId && m.user_id === subject.id)) return true;
    if (space.type === "open") return true;
  }
  return false;
}

// ── Seeding ────────────────────────────────────────────────────────────────

type Driver = ReturnType<typeof createSqliteDriver>;

async function seedWorld(driver: Driver, world: World): Promise<void> {
  const db = driver.scoped(world.workspace_id);
  for (const s of world.spaces) {
    await db
      .insertInto("spaces")
      .values({
        id: s.id,
        workspace_id: world.workspace_id,
        kind: "team",
        type: s.type,
        owner_user_id: null,
        name: s.id.slice(-6),
        slug: s.id.slice(-6),
        baseline_access: "view",
        created_by: world.users[0] ?? UserId(mintUuid()),
        created_at: 1,
        updated_at: 1,
        deleted_at: s.deleted_at,
      })
      .execute();
  }
  for (const c of world.collections) {
    await db
      .insertInto("collections")
      .values({
        id: c.id,
        workspace_id: world.workspace_id,
        parent_id: null,
        space_id: c.space_id,
        title: c.id.slice(-6),
        slug: c.id.slice(-6),
        order_key: c.id,
        created_by: world.users[0] ?? UserId(mintUuid()),
        created_at: 1,
        updated_at: 1,
        deleted_at: c.deleted_at,
      })
      .execute();
  }
  for (const d of world.docs) {
    await db
      .insertInto("docs")
      .values({
        id: d.id,
        workspace_id: world.workspace_id,
        collection_id: d.collection_id,
        title: d.id.slice(-6),
        slug: d.id.slice(-6),
        order_key: d.id,
        access_mode: d.access_mode,
        published_slug: null,
        published_at: null,
        render_version: 0,
        created_by: d.created_by,
        created_at: 1,
        updated_at: 1,
        deleted_at: d.deleted_at,
      })
      .execute();
  }
  for (const m of world.members) {
    await db
      .insertInto("space_members")
      .values({
        workspace_id: world.workspace_id,
        space_id: m.space_id,
        user_id: m.user_id,
        role: "view",
        created_at: 1,
        updated_at: 1,
      })
      .execute();
  }
  for (const g of world.grants) {
    await db
      .insertInto("grants")
      .values({
        id: GrantId(mintUuid()),
        workspace_id: world.workspace_id,
        resource_kind: g.resource_kind,
        resource_id: g.resource_id,
        subject_kind: g.subject_kind,
        subject_id: g.subject_id,
        role: "view",
        is_guest: g.is_guest,
        created_by: world.users[0] ?? UserId(mintUuid()),
        created_at: 1,
      })
      .execute();
  }
}

/** H6 garbage: grants in `host` pointing at `foreign`'s resources. */
async function seedCrossTenantGarbage(
  driver: Driver,
  host: World,
  foreign: World,
  rnd: () => number,
): Promise<void> {
  const db = driver.scoped(host.workspace_id);
  const subjects: Array<{ kind: "user" | "agent"; id: string }> = [
    ...host.users.map((u) => ({ kind: "user" as const, id: u })),
    ...host.agents.map((a) => ({ kind: "agent" as const, id: a })),
    // foreign subjects holding rows in the host tenant — also garbage
    ...foreign.users.slice(0, 1).map((u) => ({ kind: "user" as const, id: u })),
  ];
  const seenEdges = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const subject = pick(rnd, subjects);
    const onDoc = chance(rnd, 0.5);
    const resource_id = onDoc
      ? (foreign.docs[0]?.id ?? mintUuid())
      : (foreign.spaces[0]?.id ?? mintUuid());
    // Same unique-edge constraint as the in-tenant grants; foreign
    // resource ids never collide with host rows, only with our own
    // earlier garbage.
    const key = `${onDoc ? "doc" : "space"}:${resource_id}:${subject.kind}:${subject.id}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    await db
      .insertInto("grants")
      .values({
        id: GrantId(mintUuid()),
        workspace_id: host.workspace_id,
        resource_kind: onDoc ? "doc" : "space",
        resource_id,
        subject_kind: subject.kind,
        subject_id: subject.id,
        role: "view",
        is_guest: 1,
        created_by: host.users[0] ?? UserId(mintUuid()),
        created_at: 1,
      })
      .execute();
  }
}

// ── Principals ─────────────────────────────────────────────────────────────

function userPrincipal(workspace_id: WorkspaceId, id: UserId): UserPrincipal {
  return { kind: "user", id, workspace_id, roles: ["member"], session_id: null, token_id: null };
}

function agentPrincipal(
  workspace_id: WorkspaceId,
  id: AgentId,
  acting_as?: UserId,
): AgentPrincipal {
  return {
    kind: "agent",
    id,
    workspace_id,
    owner_user_id: null,
    scopes: ["doc:read"],
    token_id: TokenId("018f0000-0000-7000-8000-00000000beef"),
    token_kind: acting_as === undefined ? "api-key" : "agent-auth",
    ...(acting_as !== undefined && { acting_as }),
  };
}

// ── The fuzz loop ──────────────────────────────────────────────────────────

const ROUNDS = 60;

describe(`ceiling fuzzer — ${ROUNDS} randomized two-tenant worlds`, () => {
  it("resolver ≡ oracle for every subject × doc; foreign grants never widen; privacy holds", async () => {
    for (let seed = 1; seed <= ROUNDS; seed++) {
      const rnd = mulberry32(seed);
      const driver = createSqliteDriver({ path: ":memory:" });
      driver.exec(COLLECTIONS_DDL);
      driver.exec(SPACES_DDL);
      driver.exec(SPACE_MEMBERS_DDL);
      driver.exec(GRANTS_DDL);
      driver.exec(DOCS_DDL);
      try {
        const wsA = WorkspaceId(mintUuid());
        const wsB = WorkspaceId(mintUuid());
        const worldA = generateWorld(rnd, wsA);
        const worldB = generateWorld(rnd, wsB);
        await seedWorld(driver, worldA);
        await seedWorld(driver, worldB);
        await seedCrossTenantGarbage(driver, worldA, worldB, rnd);
        await seedCrossTenantGarbage(driver, worldB, worldA, rnd);

        const dbA = driver.scoped(wsA);
        const delegator = worldA.users[0];
        if (delegator === undefined) throw new Error("world has no users");

        // Subjects under test: every user, a plain agent, a delegated
        // agent (which must evaluate exactly as its delegator).
        const principals: Array<{ principal: Principal; subject: Subject }> = [
          ...worldA.users.map((u) => ({
            principal: userPrincipal(wsA, u) satisfies Principal,
            subject: { kind: "user", id: u } as const satisfies Subject,
          })),
          ...worldA.agents.map((a) => ({
            principal: agentPrincipal(wsA, a) satisfies Principal,
            subject: { kind: "agent", id: a } as const satisfies Subject,
          })),
          {
            principal: agentPrincipal(wsA, worldA.agents[0] ?? AgentId(mintUuid()), delegator),
            subject: { kind: "user", id: delegator },
          },
        ];

        for (const { principal, subject } of principals) {
          const acl = await loadDocReadResolver(dbA, principal);
          for (const doc of worldA.docs) {
            const row: CeilingDocRow = {
              id: doc.id,
              created_by: doc.created_by,
              access_mode: doc.access_mode,
              collection_id: doc.collection_id,
            };
            const got = acl.canRead(row);
            const want = oracleCanRead(worldA, subject, doc);
            if (got !== want) {
              expect.fail(
                `seed=${seed} subject=${subject.kind}:${subject.id.slice(-4)} doc=${doc.id.slice(-4)} ` +
                  `(mode=${doc.access_mode}, col=${doc.collection_id?.slice(-4) ?? "root"}): ` +
                  `resolver=${got} oracle=${want}`,
              );
            }
          }
        }

        // H6 sharpest case: a foreign user whose ONLY rows in tenant A
        // are the garbage grants must read nothing beyond the open
        // baselines any member-scope principal gets.
        const foreignUser = worldB.users[0];
        if (foreignUser !== undefined) {
          const acl = await loadDocReadResolver(dbA, userPrincipal(wsA, foreignUser));
          for (const doc of worldA.docs) {
            const want = oracleCanRead(worldA, { kind: "user", id: foreignUser }, doc);
            expect(acl.canRead({ ...doc })).toBe(want);
          }
        }

        // Privacy invariant, asserted off the raw model (not the oracle).
        for (const doc of worldA.docs) {
          const col = worldA.collections.find((c) => c.id === doc.collection_id);
          const space = worldA.spaces.find((s) => s.id === col?.space_id);
          const inPrivateSpace =
            space !== undefined && space.deleted_at === null && space.type === "private";
          if (doc.access_mode !== "private" && !inPrivateSpace) continue;
          for (const u of worldA.users) {
            const allowed =
              doc.created_by === u ||
              worldA.grants.some(
                (g) =>
                  g.subject_kind === "user" &&
                  g.subject_id === u &&
                  ((g.resource_kind === "doc" && g.resource_id === doc.id) ||
                    (doc.access_mode === "space" &&
                      space !== undefined &&
                      g.resource_kind === "space" &&
                      g.resource_id === space.id)),
              ) ||
              (doc.access_mode === "space" &&
                space !== undefined &&
                worldA.members.some((m) => m.space_id === space.id && m.user_id === u));
            if (allowed) continue;
            const acl = await loadDocReadResolver(dbA, userPrincipal(wsA, u));
            expect(
              acl.canRead({
                id: doc.id,
                created_by: doc.created_by,
                access_mode: doc.access_mode,
                collection_id: doc.collection_id,
              }),
            ).toBe(false);
          }
        }
      } finally {
        await driver.close();
      }
    }
  }, 30_000);
});
