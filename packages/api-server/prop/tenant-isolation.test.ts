/**
 * §8.1a capability-matrix × dual-driver tenant-isolation fuzzer
 * (architecture §8.1a "Cross-tenant leak fuzzer"; ADR 0040 Step-8
 * remainder — the full version of the resolver-grade slice in
 * `packages/capabilities/prop/ceiling-fuzzer.test.ts`).
 *
 * Drives the REAL production composition — `createApiDispatcher` +
 * `workspaceAwareGate({ loadDelegatorRoles: createLoadRoles(driver) })`
 * + `createDefaultRegistry()` — over randomized two-tenant worlds, on
 * BOTH drivers (SQLite always; Postgres via testcontainers unless
 * `EDITORZERO_SKIP_POSTGRES_TESTS=1`). "Reachable through any
 * capability call" is tested through the same gate + tx + audit path
 * production requests take, not through handlers in a fixture ctx.
 *
 * Four properties per (seed × driver):
 *
 *   1. **Foreign-resource invisibility (the §8.1a core).** Ops whose
 *      input references a tenant-B (or never-seeded) resource id,
 *      dispatched by tenant-A principals, must NEVER allow. After the
 *      full op sequence, EVERY tenant-B row across all eight
 *      tenant-scoped tables (audit + outbox included) is bit-identical
 *      to its seed — reads can't see B, mutations can't touch B,
 *      audit attribution stays in A.
 *
 *   2. **One-sided authority oracles (never-allow).** For every
 *      in-tenant op, an INDEPENDENT oracle restates the ADR's
 *      authority formula off a shadow world model (never SQL): read
 *      ceiling for doc mutations, administer ladders for ACL verbs,
 *      restore tier for space.restore, administer + placement standing
 *      for cross-boundary doc.move, the two policy rails, the
 *      guest-revoke refusal. Oracle says unauthorized ⇒ the dispatch
 *      must not allow. (The converse is deliberately NOT asserted —
 *      handlers carry non-authority preconditions (slug collisions,
 *      lifecycle conflicts, roster refusals) the oracle does not
 *      re-derive; false-allow is the security failure, false-deny is
 *      liveness and owned by the per-capability unit suites.)
 *
 *   3. **Exact read-set equality through dispatch.** `doc.list` /
 *      `space.list` results must equal the oracle's visible set — not
 *      just ⊆ tenant A. The shadow model is updated after every
 *      ALLOWED mutation (grant upserts, drops, moves incl.
 *      adopt_baseline shedding, archive/restore, membership edits,
 *      space type patches), so equality holds mid-sequence and a
 *      final per-principal sweep proves the model tracked reality
 *      through the whole walk — the capability-matrix analogue of the
 *      replay property.
 *
 *   4. **Cross-backend equivalence (the fuzzer-not-RLS guarantee).**
 *      The SAME seed produces the SAME world and op sequence on both
 *      drivers; the per-op outcome digests (outcome class + error code
 *      + deny reason + normalized allow-output) must be IDENTICAL
 *      sequences. Handler-minted ids (uuidV7 — nondeterministic) are
 *      normalized to a placeholder; arrays are canonicalized; the
 *      dispatcher clock is an injected deterministic counter shared by
 *      audit, outbox, and handler `ctx.now()`. This is the §8.1a claim
 *      verbatim: the capability returns the CORRECT result, not merely
 *      zero rows, identically on SQLite and Postgres.
 *
 * Volume: SEEDS × OPS ≈ 1k dispatches per driver per run (the §8.1a
 * per-commit target; this lane runs at pre-push via `pnpm test:prop`).
 * Deterministic: mulberry32 over seed 1..SEEDS; world + ops generated
 * ONCE per seed as plain data, then executed per driver against a
 * fresh schema.
 *
 * Out of scope here, owned elsewhere: transact-bearing capabilities
 * (doc.get / doc.create / doc.update / doc.rename need a
 * HocuspocusSync — the matrix is exactly the metadata-only + pure-read
 * ACL verbs; the ceiling read path the content verbs share is fuzzed
 * at resolver grade and their wiring is unit-tested), exact
 * deny-vs-typed-4xx classification per precondition (unit suites),
 * the audit-replay equality walk
 * (`packages/dispatcher/prop/replay.test.ts`).
 */

import { createDefaultRegistry } from "@editorzero/capabilities";
import {
  createLoadRoles,
  createOutboxWriter,
  createPostgresDriver,
  createSqliteDriver,
  POSTGRES_FULL_DDL,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { workspaceAwareGate } from "@editorzero/dispatcher";
import { EditorZeroError, PermissionDeniedError } from "@editorzero/errors";
import {
  AgentId,
  CapabilityId,
  CollectionId,
  DocId,
  GrantId,
  SpaceId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import type { AgentPrincipal, Principal, Role, UserPrincipal } from "@editorzero/principal";
import { DocListOutputSchema } from "@editorzero/schemas/doc/list";
import { DocMoveOutputSchema } from "@editorzero/schemas/doc/move";
import { SpaceListOutputSchema } from "@editorzero/schemas/space/list";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, describe, expect, it } from "vitest";

import { createApiDispatcher } from "../src/composition/createApiDispatcher";

// ── Scale ──────────────────────────────────────────────────────────────────

const SEEDS = 12;
const OPS_PER_SEED = 84; // 12 × 84 = 1008 dispatches per driver
const SKIP_POSTGRES = process.env["EDITORZERO_SKIP_POSTGRES_TESTS"] === "1";

/** Pinned image — kept in sync with `packages/db` (ADR 0023 §2). */
const POSTGRES_IMAGE = "postgres:17.4-bookworm";

// ── Deterministic PRNG (mulberry32 — same as the resolver fuzzer) ─────────

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

/**
 * Per-seed deterministic UUIDv7-shaped minter. A FACTORY (not a module
 * global like the resolver fuzzer's) so both driver runs of the same
 * seed mint IDENTICAL ids — the cross-backend digest comparison
 * depends on it. `lane` keeps independent minters (world generation /
 * garbage seeding / model placeholders) collision-free.
 */
function makeMinter(seed: number, lane = 0): () => string {
  let n = 0;
  const seedTag = seed.toString(16).padStart(4, "0");
  const laneTag = lane.toString(16).padStart(4, "0");
  return () => {
    n += 1;
    return `018f${seedTag}-${laneTag}-7000-8000-${n.toString(16).padStart(12, "0")}`;
  };
}

// ── World model (the oracle substrate — plain data, never SQL) ────────────

type WsRole = Role | null; // null = not a workspace member

interface WUser {
  id: UserId;
  wsRole: WsRole;
}
interface WSpace {
  id: SpaceId;
  kind: "team" | "personal";
  type: "open" | "closed" | "private";
  owner_user_id: UserId | null;
  deleted_at: number | null;
}
interface WCollection {
  id: CollectionId;
  space_id: SpaceId | null; // may dangle (anomaly arm — no FK by design)
  deleted_at: number | null;
}
interface WDoc {
  id: DocId;
  created_by: UserId;
  access_mode: "space" | "private";
  collection_id: CollectionId | null; // may dangle (anomaly arm)
  deleted_at: number | null;
}
interface WMember {
  space_id: SpaceId;
  user_id: UserId;
  role: "owner" | "edit" | "comment" | "view";
}
interface WGrant {
  id: GrantId;
  resource_kind: "space" | "doc";
  resource_id: string;
  subject_kind: "user" | "agent";
  subject_id: string;
  role: "owner" | "edit" | "comment" | "view";
  is_guest: 0 | 1;
}

interface World {
  workspace_id: WorkspaceId;
  users: WUser[];
  agents: AgentId[];
  spaces: WSpace[];
  collections: WCollection[];
  docs: WDoc[];
  members: WMember[];
  grants: WGrant[];
}

function cloneWorld(w: World): World {
  return {
    workspace_id: w.workspace_id,
    users: w.users.map((u) => ({ ...u })),
    agents: [...w.agents],
    spaces: w.spaces.map((s) => ({ ...s })),
    collections: w.collections.map((c) => ({ ...c })),
    docs: w.docs.map((d) => ({ ...d })),
    members: w.members.map((m) => ({ ...m })),
    grants: w.grants.map((g) => ({ ...g })),
  };
}

function generateWorld(rnd: () => number, mint: () => string, workspace_id: WorkspaceId): World {
  // Six users with a deliberate role spread; the last is NOT a
  // workspace member (subject-standing arms + delegator_not_member).
  const roles: WsRole[] = ["owner", "admin", "member", "member", "guest", null];
  const users: WUser[] = roles.map((wsRole) => ({ id: UserId(mint()), wsRole }));
  const agents = [AgentId(mint()), AgentId(mint())];

  const memberUsers = users.filter((u) => u.wsRole !== null);

  const spaces: WSpace[] = [];
  for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
    spaces.push({
      id: SpaceId(mint()),
      kind: "team",
      type: pick(rnd, ["open", "closed", "private"] as const),
      owner_user_id: null,
      deleted_at: chance(rnd, 0.2) ? 99 : null,
    });
  }
  // One personal space, owned by a random member (its administer is
  // owner-only — including against workspace admins).
  const personalOwner = pick(rnd, memberUsers).id;
  spaces.push({
    id: SpaceId(mint()),
    kind: "personal",
    type: "private",
    owner_user_id: personalOwner,
    deleted_at: null,
  });

  const collections: WCollection[] = [];
  for (let i = 0, n = 2 + Math.floor(rnd() * 4); i < n; i++) {
    collections.push({
      id: CollectionId(mint()),
      space_id: chance(rnd, 0.3)
        ? null // legacy
        : chance(rnd, 0.12)
          ? SpaceId(mint()) // dangling space ref — anomaly
          : pick(rnd, spaces).id,
      deleted_at: chance(rnd, 0.1) ? 50 : null,
    });
  }

  const docs: WDoc[] = [];
  for (let i = 0, n = 4 + Math.floor(rnd() * 8); i < n; i++) {
    docs.push({
      id: DocId(mint()),
      created_by: pick(rnd, users).id,
      access_mode: chance(rnd, 0.25) ? "private" : "space",
      collection_id: chance(rnd, 0.25)
        ? null // root
        : chance(rnd, 0.06)
          ? CollectionId(mint()) // dangling collection ref — anomaly
          : pick(rnd, collections).id,
      deleted_at: chance(rnd, 0.12) ? 70 : null,
    });
  }

  const members: WMember[] = [];
  for (const space of spaces) {
    if (space.kind === "personal") continue; // personal rosters stay empty (the pin)
    for (const u of memberUsers) {
      if (chance(rnd, 0.35)) {
        members.push({
          space_id: space.id,
          user_id: u.id,
          role: pick(rnd, ["owner", "edit", "comment", "view"] as const),
        });
      }
    }
  }

  // One guaranteed-archivable space: live, team, appended AFTER the
  // collections + members draws so nothing references it
  // (`space.archive` refuses on any live collection/doc/member — a
  // world without an empty space can never exercise its allow arm).
  spaces.push({
    id: SpaceId(mint()),
    kind: "team",
    type: pick(rnd, ["open", "closed", "private"] as const),
    owner_user_id: null,
    deleted_at: null,
  });

  const subjects: Array<{ kind: "user" | "agent"; id: string }> = [
    ...users.map((u) => ({ kind: "user" as const, id: u.id })),
    ...agents.map((a) => ({ kind: "agent" as const, id: a })),
  ];
  const grants: WGrant[] = [];
  const seenEdges = new Set<string>();
  for (let i = 0, n = 3 + Math.floor(rnd() * 8); i < n; i++) {
    const subject = pick(rnd, subjects);
    const onDoc = chance(rnd, 0.6);
    const resource_id = onDoc ? pick(rnd, docs).id : pick(rnd, spaces).id;
    const key = `${onDoc ? "doc" : "space"}:${resource_id}:${subject.kind}:${subject.id}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const is_guest = chance(rnd, 0.35) ? 1 : 0;
    grants.push({
      id: GrantId(mint()),
      resource_kind: onDoc ? "doc" : "space",
      resource_id,
      subject_kind: subject.kind,
      subject_id: subject.id,
      // Guest owner is unmintable by schema; keep the model legal.
      role:
        is_guest === 1
          ? pick(rnd, ["edit", "comment", "view"] as const)
          : pick(rnd, ["owner", "edit", "comment", "view"] as const),
      is_guest,
    });
  }

  return { workspace_id, users, agents, spaces, collections, docs, members, grants };
}

// ── Oracles — the ADR 0040 formulas restated off the model ────────────────

type Placement = { kind: "legacy" } | { kind: "space"; space_id: SpaceId } | { kind: "anomaly" };

function placementOf(world: World, collection_id: CollectionId | null): Placement {
  if (collection_id === null) return { kind: "legacy" };
  const col = world.collections.find((c) => c.id === collection_id);
  if (col === undefined) return { kind: "anomaly" };
  if (col.space_id === null) return { kind: "legacy" };
  const space = world.spaces.find((s) => s.id === col.space_id);
  if (space === undefined || space.deleted_at !== null) return { kind: "anomaly" };
  return { kind: "space", space_id: col.space_id };
}

/**
 * The evaluating identity. Delegated agents collapse to their
 * delegator's USER identity for grant/membership terms but the admin
 * backstop stays closed (`backstopRoles` empty — it is
 * user-principal-only, for ALL agents including delegated).
 */
interface OSubject {
  kind: "user" | "agent";
  id: string;
  backstopRoles: readonly Role[];
}

function adminTier(s: OSubject): boolean {
  return s.backstopRoles.some((r) => r === "owner" || r === "admin");
}

function hasGrant(
  world: World,
  s: OSubject,
  resource_kind: "space" | "doc",
  resource_id: string,
): boolean {
  return world.grants.some(
    (g) =>
      g.resource_kind === resource_kind &&
      g.resource_id === resource_id &&
      g.subject_kind === s.kind &&
      g.subject_id === s.id,
  );
}

function hasOwnerGrant(
  world: World,
  s: OSubject,
  resource_kind: "space" | "doc",
  resource_id: string,
): boolean {
  return world.grants.some(
    (g) =>
      g.resource_kind === resource_kind &&
      g.resource_id === resource_id &&
      g.subject_kind === s.kind &&
      g.subject_id === s.id &&
      g.role === "owner" &&
      g.is_guest === 0,
  );
}

function baselineReach(world: World, s: OSubject, space_id: SpaceId): boolean {
  const space = world.spaces.find((sp) => sp.id === space_id);
  if (space === undefined || space.deleted_at !== null) return false;
  if (hasGrant(world, s, "space", space_id)) return true;
  if (s.kind === "user") {
    if (world.members.some((m) => m.space_id === space_id && m.user_id === s.id)) return true;
    if (space.type === "open") return true;
    if (space.owner_user_id === s.id) return true;
  }
  return false;
}

function oracleCanRead(world: World, s: OSubject, doc: WDoc): boolean {
  if (s.kind === "user" && doc.created_by === s.id) return true;
  if (hasGrant(world, s, "doc", doc.id)) return true;
  if (doc.access_mode === "private") return false;
  const placement = placementOf(world, doc.collection_id);
  if (placement.kind === "legacy") return true;
  if (placement.kind === "anomaly") return false;
  return baselineReach(world, s, placement.space_id);
}

function spaceOwnerTierBody(
  world: World,
  s: OSubject,
  space: WSpace,
  membershipRung: boolean,
): boolean {
  if (space.kind === "personal") {
    return s.kind === "user" && space.owner_user_id === s.id;
  }
  if (
    membershipRung &&
    s.kind === "user" &&
    world.members.some((m) => m.space_id === space.id && m.user_id === s.id && m.role === "owner")
  ) {
    return true;
  }
  if (hasOwnerGrant(world, s, "space", space.id)) return true;
  return adminTier(s);
}

function oracleAdministerSpace(world: World, s: OSubject, space_id: SpaceId): boolean {
  const space = world.spaces.find((sp) => sp.id === space_id);
  if (space === undefined || space.deleted_at !== null) return false;
  return spaceOwnerTierBody(world, s, space, true);
}

/** space.restore: no liveness gate, NO membership rung (trashed roster is moot). */
function oracleRestoreSpace(world: World, s: OSubject, space_id: SpaceId): boolean {
  const space = world.spaces.find((sp) => sp.id === space_id);
  if (space === undefined) return false;
  return spaceOwnerTierBody(world, s, space, false);
}

function oracleAdministerDoc(world: World, s: OSubject, doc: WDoc): boolean {
  if (s.kind === "user" && doc.created_by === s.id) return true;
  if (hasOwnerGrant(world, s, "doc", doc.id)) return true;
  const placement = placementOf(world, doc.collection_id);
  if (placement.kind === "legacy") return adminTier(s);
  if (placement.kind === "anomaly") return false;
  return oracleAdministerSpace(world, s, placement.space_id);
}

function oraclePlaceIn(world: World, s: OSubject, collection_id: CollectionId): boolean {
  const placement = placementOf(world, collection_id);
  if (placement.kind === "legacy") return true;
  if (placement.kind === "anomaly") return false;
  return baselineReach(world, s, placement.space_id);
}

/** `space.list` visibility: live ∧ (baseline reach ∨ administer). */
function oracleVisibleSpaces(world: World, s: OSubject): Set<string> {
  const out = new Set<string>();
  for (const sp of world.spaces) {
    if (sp.deleted_at !== null) continue;
    if (baselineReach(world, s, sp.id) || oracleAdministerSpace(world, s, sp.id)) out.add(sp.id);
  }
  return out;
}

/** `doc.list` visibility: live ∧ read ceiling. */
function oracleVisibleDocs(world: World, s: OSubject): Set<string> {
  const out = new Set<string>();
  for (const d of world.docs) {
    if (d.deleted_at !== null) continue;
    if (oracleCanRead(world, s, d)) out.add(d.id);
  }
  return out;
}

// ── Op generation (pure data, shared verbatim across drivers) ─────────────

interface PrincipalSpec {
  kind: "user" | "api-key-agent" | "delegated-agent";
  user_index: number; // user identity (or delegator for delegated)
  agent_index: number; // ignored for kind=user
}

interface Op {
  capability: string;
  principal: PrincipalSpec;
  input: Record<string, unknown>;
  /** True when a resource ref in the input was swapped to a foreign/garbage id. */
  polluted: boolean;
}

/**
 * Fixed agent scope set — broad enough that agent denies exercise the
 * ACL ladder (grants / backstop closure), not just the scope gate.
 * Every literal is a real `Scope` from `ROLE_SCOPES`.
 */
const AGENT_SCOPES = [
  "doc:read",
  "doc:write",
  "permission:grant",
  "permission:revoke",
  "space:manage",
  "workspace:read",
] as const;

function generateOps(rnd: () => number, mint: () => string, world: World, foreign: World): Op[] {
  const ops: Op[] = [];

  const principalSpec = (): PrincipalSpec => {
    const r = rnd();
    if (r < 0.7) {
      return { kind: "user", user_index: Math.floor(rnd() * world.users.length), agent_index: 0 };
    }
    if (r < 0.9) {
      return {
        kind: "api-key-agent",
        user_index: 0,
        agent_index: Math.floor(rnd() * world.agents.length),
      };
    }
    return {
      kind: "delegated-agent",
      user_index: Math.floor(rnd() * world.users.length),
      agent_index: Math.floor(rnd() * world.agents.length),
    };
  };

  // Authority bias: a pure-uniform principal/target draw leaves several
  // verbs with zero ALLOWS over the whole run (the anti-vacuity floor
  // below fails) — denies dominate and the allow-side of the oracle
  // never gets exercised. So roughly half the ops aim for plausible
  // authority: the doc's creator (creator-tier administers + reads
  // everywhere except anomalies) or the workspace owner/admin claims
  // (u0/u1). The other half stays uniform so the deny lattice keeps
  // its breadth.
  const creatorSpec = (doc_id: string): PrincipalSpec | null => {
    const doc = world.docs.find((d) => d.id === doc_id);
    if (doc === undefined) return null;
    const idx = world.users.findIndex((u) => u.id === doc.created_by);
    if (idx < 0) return null;
    return { kind: "user", user_index: idx, agent_index: 0 };
  };
  const adminSpec = (): PrincipalSpec => ({
    kind: "user",
    user_index: chance(rnd, 0.5) ? 0 : 1,
    agent_index: 0,
  });
  const docPrincipal = (doc_id: string): PrincipalSpec => {
    if (chance(rnd, 0.45)) return (chance(rnd, 0.7) ? creatorSpec(doc_id) : null) ?? adminSpec();
    return principalSpec();
  };
  const spacePrincipal = (): PrincipalSpec => (chance(rnd, 0.45) ? adminSpec() : principalSpec());

  // Target pools for verbs whose allow-precondition is rare under a
  // uniform draw.
  const trashedDocs = world.docs.filter((d) => d.deleted_at !== null);
  const trashedSpaces = world.spaces.filter((s) => s.deleted_at !== null);
  const emptySpaces = world.spaces.filter(
    (sp) =>
      sp.deleted_at === null &&
      sp.kind === "team" &&
      !world.collections.some((c) => c.space_id === sp.id) &&
      !world.members.some((m) => m.space_id === sp.id),
  );
  const seededGuestEdges = world.grants.filter(
    (g) => g.is_guest === 1 && g.resource_kind === "doc",
  );
  // Correlation pools fed DURING generation: unpublish prefers docs a
  // generated publish targeted; remove_guest prefers edges a generated
  // add_guest minted. The earlier op may still deny at run time —
  // acceptable noise, the bias only has to beat zero-by-construction.
  const publishCandidates: Array<{ doc_id: string; principal: PrincipalSpec }> = [];
  const guestCandidates: Array<{
    doc_id: string;
    subject_kind: "user" | "agent";
    subject_id: string;
  }> = [];

  // Deterministic structural-deny pins: a delegated agent whose
  // delegator is the non-member (last user index) must be refused at
  // the gate (`delegator_not_member`) even on the always-allowed
  // reads. Pinned per seed instead of left to the uniform draw — a
  // run where no list op happens to land on this principal would
  // otherwise leave the read-refusal arm untested.
  const nonMemberDelegate: PrincipalSpec = {
    kind: "delegated-agent",
    user_index: world.users.length - 1,
    agent_index: 0,
  };
  ops.push({ capability: "doc.list", principal: nonMemberDelegate, input: {}, polluted: false });
  ops.push({ capability: "space.list", principal: nonMemberDelegate, input: {}, polluted: false });

  // Pinned crossing-without-authority probe: a plain member (u2 —
  // "member" claim, no admin backstop) who can READ a live legacy doc
  // (legacy baseline) but does NOT administer it (not creator, no
  // owner grant) attempts a policy-carrying crossing into a space
  // they can place into. The ONLY thing between this op and an allow
  // is `assertCanAdministerDoc` over the source — a deterministic
  // canary for the administer term; the uniform draw can miss this
  // window for an entire run (mutation-testing found exactly that).
  const memberIdx = 2; // wsRole "member" by construction
  const memberId = world.users[memberIdx]?.id;
  const nonAdministeredLegacyDoc = world.docs.find(
    (d) =>
      d.deleted_at === null &&
      d.collection_id === null &&
      d.created_by !== memberId &&
      !world.grants.some(
        (g) =>
          g.resource_kind === "doc" &&
          g.resource_id === d.id &&
          g.subject_kind === "user" &&
          g.subject_id === memberId &&
          g.role === "owner" &&
          g.is_guest === 0,
      ),
  );
  const reachableSpaceCollection = world.collections.find((c) => {
    if (c.deleted_at !== null || c.space_id === null) return false;
    const sp = world.spaces.find((x) => x.id === c.space_id);
    if (sp === undefined || sp.deleted_at !== null) return false;
    if (sp.type === "open") return true;
    return world.members.some((m) => m.space_id === sp.id && m.user_id === memberId);
  });
  if (nonAdministeredLegacyDoc !== undefined && reachableSpaceCollection !== undefined) {
    ops.push({
      capability: "doc.move",
      principal: { kind: "user", user_index: memberIdx, agent_index: 0 },
      input: {
        doc_id: nonAdministeredLegacyDoc.id,
        new_collection_id: reachableSpaceCollection.id,
        acl_policy: "keep_grants",
      },
      polluted: false,
    });
  }

  // Pollution: swap an in-tenant resource id for a foreign-tenant id
  // (or never-seeded garbage) — the op must then never allow.
  const maybePollute = (
    real: string,
    foreignPool: readonly string[],
  ): { id: string; polluted: boolean } => {
    if (chance(rnd, 0.15)) {
      if (foreignPool.length > 0 && chance(rnd, 0.75)) {
        return { id: pick(rnd, foreignPool), polluted: true };
      }
      return { id: mint(), polluted: true };
    }
    return { id: real, polluted: false };
  };

  const foreignDocIds = foreign.docs.map((d) => d.id);
  const foreignSpaceIds = foreign.spaces.map((s) => s.id);
  const foreignCollectionIds = foreign.collections.map((c) => c.id);
  const foreignGrantIds = foreign.grants.map((g) => g.id);

  // Grant/guest subjects: in-tenant users + agents, plus ONE foreign
  // user id. Subject ids are opaque strings by schema (no standing
  // validation) — a grant minted for a foreign subject lands as inert
  // garbage in tenant A (the seeded-H6 posture), NOT a leak: that
  // subject can never authenticate into workspace A. Not pollution.
  const subjectPool: Array<{ kind: "user" | "agent"; id: string }> = [
    ...world.users.map((u) => ({ kind: "user" as const, id: u.id })),
    ...world.agents.map((a) => ({ kind: "agent" as const, id: a })),
    ...foreign.users.slice(0, 1).map((u) => ({ kind: "user" as const, id: u.id })),
  ];

  for (let i = 0; i < OPS_PER_SEED; i++) {
    const die = rnd();

    if (die < 0.06) {
      ops.push({ capability: "doc.list", principal: principalSpec(), input: {}, polluted: false });
    } else if (die < 0.11) {
      ops.push({
        capability: "space.list",
        principal: principalSpec(),
        input: {},
        polluted: false,
      });
    } else if (die < 0.17) {
      const onDoc = chance(rnd, 0.6);
      const real = onDoc ? pick(rnd, world.docs).id : pick(rnd, world.spaces).id;
      const t = maybePollute(real, onDoc ? foreignDocIds : foreignSpaceIds);
      ops.push({
        capability: "permission.list",
        principal: onDoc ? docPrincipal(real) : spacePrincipal(),
        input: { resource_kind: onDoc ? "doc" : "space", resource_id: t.id },
        polluted: t.polluted,
      });
    } else if (die < 0.21) {
      const real = pick(rnd, world.docs).id;
      const t = maybePollute(real, foreignDocIds);
      // Publish authority is claim-based (admin/owner scope), not
      // creator-based — bias straight to u0/u1.
      const principal = chance(rnd, 0.6) ? adminSpec() : principalSpec();
      if (!t.polluted && principal.kind === "user" && principal.user_index <= 1) {
        publishCandidates.push({ doc_id: real, principal });
      }
      ops.push({
        capability: "doc.publish",
        principal,
        input: { doc_id: t.id },
        polluted: t.polluted,
      });
    } else if (die < 0.25) {
      if (publishCandidates.length > 0 && chance(rnd, 0.6)) {
        const cand = pick(rnd, publishCandidates);
        ops.push({
          capability: "doc.unpublish",
          principal: cand.principal,
          input: { doc_id: cand.doc_id },
          polluted: false,
        });
      } else {
        const t = maybePollute(pick(rnd, world.docs).id, foreignDocIds);
        ops.push({
          capability: "doc.unpublish",
          principal: chance(rnd, 0.6) ? adminSpec() : principalSpec(),
          input: { doc_id: t.id },
          polluted: t.polluted,
        });
      }
    } else if (die < 0.31) {
      const real = pick(rnd, world.docs).id;
      const t = maybePollute(real, foreignDocIds);
      ops.push({
        capability: "doc.delete",
        principal: docPrincipal(real),
        input: { doc_id: t.id },
        polluted: t.polluted,
      });
    } else if (die < 0.36) {
      const real =
        trashedDocs.length > 0 && chance(rnd, 0.7)
          ? pick(rnd, trashedDocs).id
          : pick(rnd, world.docs).id;
      const t = maybePollute(real, foreignDocIds);
      ops.push({
        capability: "doc.restore",
        principal: docPrincipal(real),
        input: { doc_id: t.id },
        polluted: t.polluted,
      });
    } else if (die < 0.5) {
      const realDoc = pick(rnd, world.docs).id;
      const d = maybePollute(realDoc, foreignDocIds);
      const toRoot = chance(rnd, 0.3);
      const c = toRoot
        ? { id: null, polluted: false }
        : ((): { id: string | null; polluted: boolean } => {
            const t = maybePollute(pick(rnd, world.collections).id, foreignCollectionIds);
            return { id: t.id, polluted: t.polluted };
          })();
      const input: Record<string, unknown> = { doc_id: d.id, new_collection_id: c.id };
      // Policy presence is randomized INDEPENDENTLY of crossing-ness so
      // both rails get exercised in both directions.
      if (chance(rnd, 0.55)) {
        input["acl_policy"] = pick(rnd, ["adopt_baseline", "keep_grants"] as const);
      }
      ops.push({
        capability: "doc.move",
        principal: docPrincipal(realDoc),
        input,
        polluted: d.polluted || c.polluted,
      });
    } else if (die < 0.61) {
      const onDoc = chance(rnd, 0.6);
      const real = onDoc ? pick(rnd, world.docs).id : pick(rnd, world.spaces).id;
      const t = maybePollute(real, onDoc ? foreignDocIds : foreignSpaceIds);
      const subject = pick(rnd, subjectPool);
      ops.push({
        capability: "permission.grant",
        principal: onDoc ? docPrincipal(real) : spacePrincipal(),
        input: {
          resource_kind: onDoc ? "doc" : "space",
          resource_id: t.id,
          subject_kind: subject.kind,
          subject_id: subject.id,
          role: pick(rnd, ["owner", "edit", "comment", "view"] as const),
        },
        polluted: t.polluted,
      });
    } else if (die < 0.67) {
      const realGrant = pick(rnd, world.grants);
      const t = maybePollute(realGrant.id, foreignGrantIds);
      const principal =
        realGrant.resource_kind === "doc" ? docPrincipal(realGrant.resource_id) : spacePrincipal();
      ops.push({
        capability: "permission.revoke",
        principal,
        input: { grant_id: t.id },
        polluted: t.polluted,
      });
    } else if (die < 0.74) {
      const real = pick(rnd, world.docs).id;
      const t = maybePollute(real, foreignDocIds);
      const subject = pick(rnd, subjectPool);
      if (!t.polluted) {
        guestCandidates.push({ doc_id: real, subject_kind: subject.kind, subject_id: subject.id });
      }
      ops.push({
        capability: "doc.add_guest",
        principal: docPrincipal(real),
        input: {
          doc_id: t.id,
          subject_kind: subject.kind,
          subject_id: subject.id,
          role: pick(rnd, ["edit", "comment", "view"] as const),
        },
        polluted: t.polluted,
      });
    } else if (die < 0.79) {
      // Bias toward edges that exist: seeded guest grants, then edges
      // an earlier add_guest op targeted; uniform draw as the floor.
      const edge =
        seededGuestEdges.length > 0 && chance(rnd, 0.4)
          ? ((): { doc_id: string; subject_kind: "user" | "agent"; subject_id: string } => {
              const g = pick(rnd, seededGuestEdges);
              return {
                doc_id: g.resource_id,
                subject_kind: g.subject_kind,
                subject_id: g.subject_id,
              };
            })()
          : guestCandidates.length > 0 && chance(rnd, 0.5)
            ? pick(rnd, guestCandidates)
            : ((): { doc_id: string; subject_kind: "user" | "agent"; subject_id: string } => {
                const subject = pick(rnd, subjectPool);
                return {
                  doc_id: pick(rnd, world.docs).id,
                  subject_kind: subject.kind,
                  subject_id: subject.id,
                };
              })();
      const t = maybePollute(edge.doc_id, foreignDocIds);
      ops.push({
        capability: "doc.remove_guest",
        principal: docPrincipal(edge.doc_id),
        input: { doc_id: t.id, subject_kind: edge.subject_kind, subject_id: edge.subject_id },
        polluted: t.polluted,
      });
    } else if (die < 0.83) {
      const t = maybePollute(pick(rnd, world.spaces).id, foreignSpaceIds);
      const input: Record<string, unknown> = { space_id: t.id };
      if (chance(rnd, 0.6)) input["name"] = `n${i}`;
      else input["space_type"] = pick(rnd, ["open", "closed", "private"] as const);
      ops.push({
        capability: "space.update",
        principal: spacePrincipal(),
        input,
        polluted: t.polluted,
      });
    } else if (die < 0.86) {
      // Bias toward descendant-free spaces — the only ones whose
      // allow arm is reachable (live collections/docs/members refuse).
      const real =
        emptySpaces.length > 0 && chance(rnd, 0.5)
          ? pick(rnd, emptySpaces).id
          : pick(rnd, world.spaces).id;
      const t = maybePollute(real, foreignSpaceIds);
      ops.push({
        capability: "space.archive",
        principal: spacePrincipal(),
        input: { space_id: t.id },
        polluted: t.polluted,
      });
    } else if (die < 0.89) {
      const real =
        trashedSpaces.length > 0 && chance(rnd, 0.7)
          ? pick(rnd, trashedSpaces).id
          : pick(rnd, world.spaces).id;
      const t = maybePollute(real, foreignSpaceIds);
      ops.push({
        capability: "space.restore",
        principal: spacePrincipal(),
        input: { space_id: t.id },
        polluted: t.polluted,
      });
    } else if (die < 0.94) {
      const t = maybePollute(pick(rnd, world.spaces).id, foreignSpaceIds);
      ops.push({
        capability: "space.member_add",
        principal: spacePrincipal(),
        input: {
          space_id: t.id,
          user_id: pick(rnd, world.users).id,
          role: pick(rnd, ["owner", "edit", "comment", "view"] as const),
        },
        polluted: t.polluted,
      });
    } else if (die < 0.97) {
      // Bias toward (space, user) pairs that are actually on a roster.
      const pair =
        world.members.length > 0 && chance(rnd, 0.7)
          ? pick(rnd, world.members)
          : { space_id: pick(rnd, world.spaces).id, user_id: pick(rnd, world.users).id };
      const t = maybePollute(pair.space_id, foreignSpaceIds);
      ops.push({
        capability: "space.member_update_role",
        principal: spacePrincipal(),
        input: {
          space_id: t.id,
          user_id: pair.user_id,
          role: pick(rnd, ["owner", "edit", "comment", "view"] as const),
        },
        polluted: t.polluted,
      });
    } else {
      const pair =
        world.members.length > 0 && chance(rnd, 0.7)
          ? pick(rnd, world.members)
          : { space_id: pick(rnd, world.spaces).id, user_id: pick(rnd, world.users).id };
      const t = maybePollute(pair.space_id, foreignSpaceIds);
      ops.push({
        capability: "space.member_remove",
        principal: spacePrincipal(),
        input: { space_id: t.id, user_id: pair.user_id },
        polluted: t.polluted,
      });
    }
  }
  return ops;
}

// ── Oracle: "must this op be refused?" (one-sided — see header) ───────────

function subjectFor(world: World, spec: PrincipalSpec): OSubject | null {
  if (spec.kind === "user") {
    const u = world.users[spec.user_index];
    if (u === undefined) throw new Error("bad user index");
    // The non-member CLAIMS "member" (buildPrincipal mirrors this) —
    // role claims come from the auth layer, the gate trusts them for
    // users. The backstop only matters for owner/admin, which the
    // non-member doesn't claim.
    return { kind: "user", id: u.id, backstopRoles: u.wsRole === null ? ["member"] : [u.wsRole] };
  }
  if (spec.kind === "api-key-agent") {
    const a = world.agents[spec.agent_index];
    if (a === undefined) throw new Error("bad agent index");
    return { kind: "agent", id: a, backstopRoles: [] };
  }
  // Delegated: evaluates grant/membership terms as the DELEGATOR's
  // user identity, but the admin backstop stays closed (agent
  // principal). A delegator with no live workspace membership is
  // structurally denied at the gate — no subject to evaluate.
  const u = world.users[spec.user_index];
  if (u === undefined) throw new Error("bad user index");
  if (u.wsRole === null) return null;
  return { kind: "user", id: u.id, backstopRoles: [] };
}

/**
 * Returns true when the oracle can PROVE the op must not allow.
 * Conservative: unmodelled preconditions return false (no claim);
 * the dispatch may still refuse for reasons the oracle doesn't track.
 */
function oracleForbids(world: World, op: Op): boolean {
  const s = subjectFor(world, op.principal);
  if (s === null) return true; // delegator_not_member — gate must deny

  const docById = (id: unknown): WDoc | undefined => world.docs.find((d) => d.id === id);
  const spaceById = (id: unknown): WSpace | undefined => world.spaces.find((sp) => sp.id === id);

  switch (op.capability) {
    case "doc.list":
    case "space.list":
      return false;
    case "permission.list": {
      if (op.input["resource_kind"] === "doc") {
        const d = docById(op.input["resource_id"]);
        return d === undefined || !oracleAdministerDoc(world, s, d);
      }
      const sp = spaceById(op.input["resource_id"]);
      return sp === undefined || !oracleAdministerSpace(world, s, sp.id);
    }
    case "doc.delete": {
      const d = docById(op.input["doc_id"]);
      if (d === undefined || d.deleted_at !== null) return true; // 404 surface
      return !oracleCanRead(world, s, d);
    }
    case "doc.publish":
    case "doc.unpublish": {
      // `doc:publish` is admin/owner-only in ROLE_SCOPES; AGENT_SCOPES
      // deliberately omits it (so the agent arm pins the scope gate).
      if (op.principal.kind !== "user") return true;
      const claimed = world.users[op.principal.user_index]?.wsRole ?? "member";
      if (claimed !== "admin" && claimed !== "owner") return true;
      const d = docById(op.input["doc_id"]);
      if (d === undefined || d.deleted_at !== null) return true; // 404 surface
      return !oracleCanRead(world, s, d);
    }
    case "doc.restore": {
      const d = docById(op.input["doc_id"]);
      if (d === undefined || d.deleted_at === null) return true; // 404 — not in trash
      return !oracleCanRead(world, s, d);
    }
    case "doc.move": {
      const d = docById(op.input["doc_id"]);
      if (d === undefined || d.deleted_at !== null) return true;
      if (!oracleCanRead(world, s, d)) return true;
      const targetRaw = op.input["new_collection_id"];
      const target = targetRaw === null ? null : CollectionId(String(targetRaw));
      if (target !== null) {
        const col = world.collections.find((c) => c.id === target);
        if (col === undefined || col.deleted_at !== null) return true; // 404 surface
      }
      const src = placementOf(world, d.collection_id);
      const dst = placementOf(world, target);
      const sameBucket =
        (src.kind === "legacy" && dst.kind === "legacy") ||
        (src.kind === "space" && dst.kind === "space" && src.space_id === dst.space_id);
      const policy = op.input["acl_policy"];
      if (sameBucket) return policy !== undefined; // not-applicable rail
      // Crossing: authority + placement standing + the required-policy rail.
      if (!oracleAdministerDoc(world, s, d)) return true;
      if (target !== null && !oraclePlaceIn(world, s, target)) return true;
      return policy === undefined; // required rail
    }
    case "permission.grant": {
      if (op.input["resource_kind"] === "doc") {
        const d = docById(op.input["resource_id"]);
        if (d === undefined || d.deleted_at !== null) return true;
        if (!oracleAdministerDoc(world, s, d)) return true;
        // Slice-1 MUST-FIX: anomalous placement refuses every grant.
        return placementOf(world, d.collection_id).kind === "anomaly";
      }
      const sp = spaceById(op.input["resource_id"]);
      return sp === undefined || !oracleAdministerSpace(world, s, sp.id);
    }
    case "permission.revoke": {
      const g = world.grants.find((gr) => gr.id === op.input["grant_id"]);
      if (g === undefined) return true;
      if (g.is_guest === 1) return true; // standing lane refuses guest edges
      if (g.resource_kind === "doc") {
        const d = docById(g.resource_id);
        return d === undefined || d.deleted_at !== null || !oracleAdministerDoc(world, s, d);
      }
      const sp = spaceById(g.resource_id);
      return sp === undefined || !oracleAdministerSpace(world, s, sp.id);
    }
    case "doc.add_guest": {
      const d = docById(op.input["doc_id"]);
      if (d === undefined || d.deleted_at !== null) return true;
      return !oracleAdministerDoc(world, s, d); // anomaly does NOT refuse guests
    }
    case "doc.remove_guest": {
      // Works on trashed docs; authority over the STORED placement.
      const d = docById(op.input["doc_id"]);
      if (d === undefined) return true;
      return !oracleAdministerDoc(world, s, d);
    }
    case "space.update":
    case "space.archive":
    case "space.member_add":
    case "space.member_update_role":
    case "space.member_remove": {
      const sp = spaceById(op.input["space_id"]);
      if (sp === undefined) return true;
      return !oracleAdministerSpace(world, s, sp.id);
    }
    case "space.restore": {
      const sp = spaceById(op.input["space_id"]);
      if (sp === undefined) return true;
      return !oracleRestoreSpace(world, s, sp.id);
    }
    default:
      throw new Error(`oracleForbids: unmapped capability ${op.capability}`);
  }
}

// ── Shadow-apply: keep the model in lockstep with ALLOWED mutations ───────

function applyAllowed(world: World, op: Op, output: unknown, mintModelId: () => string): void {
  switch (op.capability) {
    case "doc.delete": {
      const d = world.docs.find((x) => x.id === op.input["doc_id"]);
      if (d !== undefined) d.deleted_at = 1;
      return;
    }
    case "doc.restore": {
      const d = world.docs.find((x) => x.id === op.input["doc_id"]);
      if (d !== undefined) d.deleted_at = null;
      return;
    }
    case "doc.move": {
      const parsed = DocMoveOutputSchema.parse(output);
      const d = world.docs.find((x) => x.id === op.input["doc_id"]);
      if (d === undefined) return;
      d.collection_id = parsed.new_collection_id;
      if (parsed.acl_transition?.policy === "adopt_baseline") {
        world.grants = world.grants.filter(
          (g) => !(g.resource_kind === "doc" && g.resource_id === d.id),
        );
      }
      return;
    }
    case "permission.grant":
    case "doc.add_guest": {
      const onDoc = op.capability === "doc.add_guest" || op.input["resource_kind"] === "doc";
      const resource_id = String(
        op.capability === "doc.add_guest" ? op.input["doc_id"] : op.input["resource_id"],
      );
      const subject_kind =
        op.input["subject_kind"] === "agent" ? ("agent" as const) : ("user" as const);
      const subject_id = String(op.input["subject_id"]);
      const role = ((): WGrant["role"] => {
        const r = op.input["role"];
        return r === "owner" || r === "edit" || r === "comment" ? r : "view";
      })();
      const existing = world.grants.find(
        (g) =>
          g.resource_kind === (onDoc ? "doc" : "space") &&
          g.resource_id === resource_id &&
          g.subject_kind === subject_kind &&
          g.subject_id === subject_id,
      );
      if (existing !== undefined) {
        // Same-edge re-grant: if the handler allowed it (vs a lifecycle
        // conflict), it converged the role.
        existing.role = role;
        return;
      }
      world.grants.push({
        // Handler-minted id differs per driver run; ops never reference
        // it and digests normalize it — a model-lane placeholder id
        // keeps the model self-consistent.
        id: GrantId(mintModelId()),
        resource_kind: onDoc ? "doc" : "space",
        resource_id,
        subject_kind,
        subject_id,
        role,
        is_guest: op.capability === "doc.add_guest" ? 1 : 0,
      });
      return;
    }
    case "permission.revoke": {
      world.grants = world.grants.filter((g) => g.id !== op.input["grant_id"]);
      return;
    }
    case "doc.remove_guest": {
      world.grants = world.grants.filter(
        (g) =>
          !(
            g.resource_kind === "doc" &&
            g.resource_id === op.input["doc_id"] &&
            g.subject_kind === op.input["subject_kind"] &&
            g.subject_id === op.input["subject_id"] &&
            g.is_guest === 1
          ),
      );
      return;
    }
    case "space.update": {
      const sp = world.spaces.find((x) => x.id === op.input["space_id"]);
      if (sp === undefined) return;
      const t = op.input["space_type"];
      if (t === "open" || t === "closed" || t === "private") sp.type = t;
      return;
    }
    case "space.archive": {
      const sp = world.spaces.find((x) => x.id === op.input["space_id"]);
      if (sp !== undefined) sp.deleted_at = 1;
      return;
    }
    case "space.restore": {
      const sp = world.spaces.find((x) => x.id === op.input["space_id"]);
      if (sp !== undefined) sp.deleted_at = null;
      return;
    }
    case "space.member_add": {
      world.members.push({
        space_id: SpaceId(String(op.input["space_id"])),
        user_id: UserId(String(op.input["user_id"])),
        role: ((): WMember["role"] => {
          const r = op.input["role"];
          return r === "owner" || r === "edit" || r === "comment" ? r : "view";
        })(),
      });
      return;
    }
    case "space.member_update_role": {
      const m = world.members.find(
        (x) => x.space_id === op.input["space_id"] && x.user_id === op.input["user_id"],
      );
      if (m !== undefined) {
        const r = op.input["role"];
        if (r === "owner" || r === "edit" || r === "comment" || r === "view") m.role = r;
      }
      return;
    }
    case "space.member_remove": {
      world.members = world.members.filter(
        (x) => !(x.space_id === op.input["space_id"] && x.user_id === op.input["user_id"]),
      );
      return;
    }
    default:
      return; // reads + publish/unpublish: no ACL-relevant model change
  }
}

// ── Seeding ────────────────────────────────────────────────────────────────

type FuzzDriver = Pick<SqliteDriver, "withSystemTx" | "scoped" | "system">;

async function seedWorld(driver: FuzzDriver, world: World): Promise<void> {
  const db = driver.scoped(world.workspace_id);
  for (const u of world.users) {
    if (u.wsRole === null) continue;
    await db
      .insertInto("workspace_members")
      .values({
        workspace_id: world.workspace_id,
        user_id: u.id,
        role: u.wsRole,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }
  for (const s of world.spaces) {
    await db
      .insertInto("spaces")
      .values({
        id: s.id,
        workspace_id: world.workspace_id,
        kind: s.kind,
        type: s.type,
        owner_user_id: s.owner_user_id,
        name: `s-${s.id.slice(-6)}`,
        slug: `s-${s.id.slice(-6)}`,
        baseline_access: "view",
        created_by: world.users[0]?.id ?? UserId(s.id),
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
        title: `c-${c.id.slice(-6)}`,
        slug: `c-${c.id.slice(-6)}`,
        order_key: c.id,
        created_by: world.users[0]?.id ?? UserId(c.id),
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
        title: `d-${d.id.slice(-6)}`,
        slug: `d-${d.id.slice(-6)}`,
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
        role: m.role,
        created_at: 1,
        updated_at: 1,
      })
      .execute();
  }
  for (const g of world.grants) {
    await db
      .insertInto("grants")
      .values({
        id: g.id,
        workspace_id: world.workspace_id,
        resource_kind: g.resource_kind,
        resource_id: g.resource_id,
        subject_kind: g.subject_kind,
        subject_id: g.subject_id,
        role: g.role,
        is_guest: g.is_guest,
        created_by: world.users[0]?.id ?? UserId(g.resource_id),
        created_at: 1,
      })
      .execute();
  }
}

/**
 * H6 garbage: grants in `host` whose resource ids point at `foreign`
 * rows, at owner role (maximally dangerous). The ladder must treat
 * them as inert — every resource lookup is tenant-scoped, so the edge
 * can never bind.
 */
async function seedGarbage(
  driver: FuzzDriver,
  host: World,
  foreign: World,
  mint: () => string,
): Promise<void> {
  const db = driver.scoped(host.workspace_id);
  const subjects = [
    { kind: "user" as const, id: host.users[0]?.id ?? mint() },
    { kind: "user" as const, id: foreign.users[0]?.id ?? mint() },
    { kind: "agent" as const, id: host.agents[0] ?? mint() },
  ];
  let i = 0;
  for (const subject of subjects) {
    const onDoc = i % 2 === 0;
    const resource_id = onDoc ? (foreign.docs[0]?.id ?? mint()) : (foreign.spaces[0]?.id ?? mint());
    await db
      .insertInto("grants")
      .values({
        id: GrantId(mint()),
        workspace_id: host.workspace_id,
        resource_kind: onDoc ? "doc" : "space",
        resource_id,
        subject_kind: subject.kind,
        subject_id: subject.id,
        role: "owner",
        is_guest: 0,
        created_by: host.users[0]?.id ?? UserId(resource_id),
        created_at: 1,
      })
      .execute();
    i += 1;
  }
}

// ── Principals + outcome classification ───────────────────────────────────

function buildPrincipal(world: World, spec: PrincipalSpec): Principal {
  if (spec.kind === "user") {
    const u = world.users[spec.user_index];
    if (u === undefined) throw new Error("bad user index");
    const principal: UserPrincipal = {
      kind: "user",
      id: u.id,
      workspace_id: world.workspace_id,
      // The non-member claims "member" — workspace_members has no row,
      // exercising the ladder from the claim/row gap side (user role
      // claims are the auth layer's to verify, not the gate's).
      roles: [u.wsRole ?? "member"],
      session_id: null,
      token_id: null,
    };
    return principal;
  }
  const agent = world.agents[spec.agent_index];
  if (agent === undefined) throw new Error("bad agent index");
  const base = {
    kind: "agent" as const,
    id: agent,
    workspace_id: world.workspace_id,
    owner_user_id: world.users[0]?.id ?? null,
    scopes: [...AGENT_SCOPES],
    token_id: TokenId("018f0000-0000-7000-8000-00000000beef"),
  };
  if (spec.kind === "api-key-agent") {
    const principal: AgentPrincipal = { ...base, token_kind: "api-key" };
    return principal;
  }
  const delegator = world.users[spec.user_index];
  if (delegator === undefined) throw new Error("bad user index");
  const principal: AgentPrincipal = {
    ...base,
    token_kind: "agent-auth",
    acting_as: delegator.id,
  };
  return principal;
}

interface Outcome {
  kind: "allow" | "deny" | "error";
  code: string | null;
  digest: unknown;
}

/**
 * Normalize a value for cross-driver comparison: any UUID string NOT
 * minted at plan time (handler-minted grant ids) collapses to
 * "<minted>".
 *
 * Array ORDER IS PRESERVED — ordering is part of the read contracts
 * (`doc.list` by order_key, `space.list` by name+id, `permission.list`
 * by created_at+id, all cross-driver-deterministic over seeded ids and
 * the injected clock), so a backend returning the same rows in a
 * different order must FAIL the digest equality (Codex review
 * 2026-06-12 — blanket sorting masked exactly that). The single
 * exception: `dropped_grants` is handler-sorted by `grant_id`, and
 * runtime-minted ids are nondeterministic ACROSS drivers — its
 * contract order is itself nondeterministic under normalization, so
 * that one field digests as a bag.
 */
function normalize(value: unknown, seededIds: ReadonlySet<string>, key?: string): unknown {
  if (typeof value === "string") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
      !seededIds.has(value)
      ? "<minted>"
      : value;
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => normalize(v, seededIds));
    if (key === "dropped_grants") {
      return items
        .map((v) => JSON.stringify(v))
        .sort()
        .map((s): unknown => JSON.parse(s));
    }
    return items;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, seededIds, k);
    return out;
  }
  return value;
}

// ── The per-driver run ─────────────────────────────────────────────────────

interface SeedPlan {
  seed: number;
  worldA: World;
  worldB: World;
  ops: Op[];
  seededIds: ReadonlySet<string>;
}

function makePlan(seed: number): SeedPlan {
  const rnd = mulberry32(seed);
  const mint = makeMinter(seed);
  const worldA = generateWorld(rnd, mint, WorkspaceId(mint()));
  const worldB = generateWorld(rnd, mint, WorkspaceId(mint()));
  const ops = generateOps(rnd, mint, worldA, worldB);
  const ids = new Set<string>();
  for (const w of [worldA, worldB]) {
    ids.add(w.workspace_id);
    for (const u of w.users) ids.add(u.id);
    for (const a of w.agents) ids.add(a);
    for (const s of w.spaces) ids.add(s.id);
    for (const c of w.collections) ids.add(c.id);
    for (const d of w.docs) ids.add(d.id);
    for (const g of w.grants) ids.add(g.id);
  }
  return { seed, worldA, worldB, ops, seededIds: ids };
}

const TENANT_TABLES = [
  "workspace_members",
  "spaces",
  "collections",
  "docs",
  "space_members",
  "grants",
  "audit_events",
  "outbox",
] as const;

async function snapshotTenant(
  driver: FuzzDriver,
  workspace_id: WorkspaceId,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TENANT_TABLES) {
    const rows: unknown[] = await driver
      .system()
      .selectFrom(table)
      .selectAll()
      .where("workspace_id", "=", workspace_id)
      .execute();
    out[table] = rows
      .map((r) => JSON.stringify(r))
      .sort()
      .map((s): unknown => JSON.parse(s));
  }
  return out;
}

async function runPlanOnDriver(plan: SeedPlan, driver: FuzzDriver): Promise<Outcome[]> {
  await seedWorld(driver, plan.worldA);
  await seedWorld(driver, plan.worldB);
  const garbageMint = makeMinter(plan.seed, 1);
  await seedGarbage(driver, plan.worldA, plan.worldB, garbageMint);
  await seedGarbage(driver, plan.worldB, plan.worldA, garbageMint);

  const foreignBefore = await snapshotTenant(driver, plan.worldB.workspace_id);

  // One deterministic clock for audit rows, outbox rows, and handler
  // `ctx.now()` — both driver runs replay the identical tick sequence,
  // so timestamp-bearing outputs digest identically.
  let tick = 1000;
  const clock = (): number => {
    tick += 1;
    return tick;
  };
  const dispatcher = createApiDispatcher({
    driver,
    registry: createDefaultRegistry(),
    gate: workspaceAwareGate({ loadDelegatorRoles: createLoadRoles(driver) }),
    outboxWriter: createOutboxWriter(clock),
    now: clock,
  });

  // The drifting shadow model — every ALLOWED mutation applies.
  const model = cloneWorld(plan.worldA);
  const modelMint = makeMinter(plan.seed, 2);
  const outcomes: Outcome[] = [];

  for (const op of plan.ops) {
    const principal = buildPrincipal(model, op.principal);
    let outcome: Outcome;
    let rawOutput: unknown = null;
    try {
      rawOutput = await dispatcher.dispatch({
        capability_id: CapabilityId(op.capability),
        input: op.input,
        principal,
        access: { workspace_id: model.workspace_id },
        trace_id: null,
      });
      outcome = { kind: "allow", code: null, digest: normalize(rawOutput, plan.seededIds) };
    } catch (err) {
      if (!(err instanceof EditorZeroError)) throw err; // unexpected = suite failure
      outcome = {
        kind: err instanceof PermissionDeniedError ? "deny" : "error",
        code: err.code,
        digest: err instanceof PermissionDeniedError ? normalize(err.reason, plan.seededIds) : null,
      };
    }
    outcomes.push(outcome);

    // Property 1 — pollution never allows.
    if (op.polluted && outcome.kind === "allow") {
      expect.fail(
        `seed=${plan.seed} op#${outcomes.length - 1} ${op.capability}: ` +
          `foreign/garbage-referencing input was ALLOWED: ${JSON.stringify(op.input)}`,
      );
    }
    // Property 2 — the one-sided authority oracle.
    if (!op.polluted && outcome.kind === "allow" && oracleForbids(model, op)) {
      expect.fail(
        `seed=${plan.seed} op#${outcomes.length - 1} ${op.capability}: oracle forbids but ` +
          `dispatch ALLOWED. principal=${JSON.stringify(op.principal)} input=${JSON.stringify(op.input)}`,
      );
    }

    if (outcome.kind === "allow") applyAllowed(model, op, rawOutput, modelMint);

    // Property 3 — exact read-set equality, in-sequence on the
    // drifted model.
    if (outcome.kind === "allow" && op.capability === "doc.list") {
      const s = subjectFor(model, op.principal);
      if (s !== null) {
        const got = new Set(DocListOutputSchema.parse(rawOutput).docs.map((d) => String(d.id)));
        expect(got, `seed=${plan.seed} doc.list visible-set mismatch`).toEqual(
          oracleVisibleDocs(model, s),
        );
      }
    }
    if (outcome.kind === "allow" && op.capability === "space.list") {
      const s = subjectFor(model, op.principal);
      if (s !== null) {
        const got = new Set(
          SpaceListOutputSchema.parse(rawOutput).spaces.map((r) => String(r.space_id)),
        );
        expect(got, `seed=${plan.seed} space.list visible-set mismatch`).toEqual(
          oracleVisibleSpaces(model, s),
        );
      }
    }
  }

  // Final sweep — prove the model tracked reality through every
  // allowed mutation: BOTH read verbs, for EVERY principal shape
  // (users, api-key agents, one delegated pairing per user — Codex
  // review 2026-06-12: a user-doc.list-only sweep left late space
  // mutations and the agent/delegated read semantics to opportunistic
  // in-sequence hits). The non-member delegator skips dispatch — its
  // structural deny is pinned per seed at the head of the op list.
  const sweepSpecs: PrincipalSpec[] = [
    ...model.users.map((_, i): PrincipalSpec => ({ kind: "user", user_index: i, agent_index: 0 })),
    ...model.agents.map(
      (_, a): PrincipalSpec => ({ kind: "api-key-agent", user_index: 0, agent_index: a }),
    ),
    ...model.users.map(
      (_, i): PrincipalSpec => ({
        kind: "delegated-agent",
        user_index: i,
        agent_index: i % model.agents.length,
      }),
    ),
  ];
  for (const [sweepIdx, spec] of sweepSpecs.entries()) {
    const s = subjectFor(model, spec);
    if (s === null) continue;
    const principal = buildPrincipal(model, spec);
    const docResult = await dispatcher.dispatch({
      capability_id: CapabilityId("doc.list"),
      input: {},
      principal,
      access: { workspace_id: model.workspace_id },
      trace_id: null,
    });
    const gotDocs = new Set(DocListOutputSchema.parse(docResult).docs.map((d) => String(d.id)));
    expect(gotDocs, `seed=${plan.seed} final doc.list sweep principal#${sweepIdx}`).toEqual(
      oracleVisibleDocs(model, s),
    );
    const spaceResult = await dispatcher.dispatch({
      capability_id: CapabilityId("space.list"),
      input: {},
      principal,
      access: { workspace_id: model.workspace_id },
      trace_id: null,
    });
    const gotSpaces = new Set(
      SpaceListOutputSchema.parse(spaceResult).spaces.map((r) => String(r.space_id)),
    );
    expect(gotSpaces, `seed=${plan.seed} final space.list sweep principal#${sweepIdx}`).toEqual(
      oracleVisibleSpaces(model, s),
    );
  }

  // Property 1 (mutation half) — tenant B is bit-identical across all
  // eight tenant-scoped tables; audit attribution included (B gained
  // zero rows of anything).
  const foreignAfter = await snapshotTenant(driver, plan.worldB.workspace_id);
  expect(foreignAfter, `seed=${plan.seed}: tenant-B rows changed`).toEqual(foreignBefore);

  return outcomes;
}

// ── The suite ──────────────────────────────────────────────────────────────

/** Mirrors `packages/db/test/integration/backends.ts` DROP order (FK-safe). */
const PG_DROP_ALL = `
  DROP TABLE IF EXISTS grants;
  DROP TABLE IF EXISTS space_members;
  DROP TABLE IF EXISTS spaces;
  DROP TABLE IF EXISTS outbox;
  DROP TABLE IF EXISTS audit_events;
  DROP TABLE IF EXISTS doc_counters;
  DROP TABLE IF EXISTS doc_updates;
  DROP TABLE IF EXISTS doc_snapshots;
  DROP TABLE IF EXISTS workspace_members;
  DROP TABLE IF EXISTS docs;
  DROP TABLE IF EXISTS collections;
  DROP TABLE IF EXISTS workspaces;
`;

let pgContainer: StartedPostgreSqlContainer | null = null;

afterAll(async () => {
  if (pgContainer !== null) await pgContainer.stop();
});

/**
 * Anti-vacuity floor: every capability in the matrix must reach at
 * least one ALLOW and one non-allow across the whole run, and the
 * pollution arm must actually fire. Without this, a generator
 * regression (an input shape drifting invalid, a weight collapsing to
 * zero) would leave the never-allow properties green while testing
 * nothing.
 */
const MATRIX_CAPABILITIES = [
  "doc.list",
  "space.list",
  "permission.list",
  "doc.publish",
  "doc.unpublish",
  "doc.delete",
  "doc.restore",
  "doc.move",
  "permission.grant",
  "permission.revoke",
  "doc.add_guest",
  "doc.remove_guest",
  "space.update",
  "space.archive",
  "space.restore",
  "space.member_add",
  "space.member_update_role",
  "space.member_remove",
] as const;

function assertMatrixCoverage(plans: readonly SeedPlan[], bySeed: Map<number, Outcome[]>): void {
  const allows = new Map<string, number>();
  const refusals = new Map<string, number>();
  let pollutedOps = 0;
  for (const plan of plans) {
    const outcomes = bySeed.get(plan.seed);
    if (outcomes === undefined) continue;
    plan.ops.forEach((op, i) => {
      const o = outcomes[i];
      if (o === undefined) return;
      if (op.polluted) pollutedOps += 1;
      const lane = o.kind === "allow" ? allows : refusals;
      lane.set(op.capability, (lane.get(op.capability) ?? 0) + 1);
    });
  }
  const table = MATRIX_CAPABILITIES.map(
    (c) => `${c}: allow=${allows.get(c) ?? 0} refuse=${refusals.get(c) ?? 0}`,
  ).join("\n");
  for (const c of MATRIX_CAPABILITIES) {
    expect(
      allows.get(c) ?? 0,
      `capability ${c} never ALLOWED — vacuous fuzz?\n${table}`,
    ).toBeGreaterThan(0);
    expect(
      refusals.get(c) ?? 0,
      `capability ${c} never refused — oracle arm untested?\n${table}`,
    ).toBeGreaterThan(0);
  }
  expect(pollutedOps, "pollution arm never fired").toBeGreaterThan(50);
}

describe(`§8.1a tenant-isolation fuzz — ${SEEDS} worlds × ${OPS_PER_SEED} ops per driver`, () => {
  const plans = Array.from({ length: SEEDS }, (_, i) => makePlan(i + 1));
  const sqliteOutcomes = new Map<number, Outcome[]>();

  it("sqlite: isolation + authority oracle + read-set equality hold over the full matrix", async () => {
    for (const plan of plans) {
      const driver = createSqliteDriver({ path: ":memory:" });
      driver.exec(SQLITE_FULL_DDL);
      try {
        sqliteOutcomes.set(plan.seed, await runPlanOnDriver(plan, driver));
      } finally {
        await driver.close();
      }
    }
    assertMatrixCoverage(plans, sqliteOutcomes);
  }, 120_000);

  it.skipIf(SKIP_POSTGRES)(
    "postgres: same properties + outcome-sequence equivalence with sqlite",
    async () => {
      pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase("editorzero_fuzz")
        .withUsername("test")
        .withPassword("test")
        .start();
      const driver = createPostgresDriver({
        connectionString: pgContainer.getConnectionUri(),
      });
      try {
        for (const plan of plans) {
          await driver.exec(PG_DROP_ALL);
          await driver.exec(POSTGRES_FULL_DDL);
          const pgOutcomes = await runPlanOnDriver(plan, driver);
          const sq = sqliteOutcomes.get(plan.seed);
          expect(sq, `seed=${plan.seed}: sqlite run missing`).toBeDefined();
          // Property 4 — the cross-backend guarantee: identical outcome
          // sequences, allow-digests and deny reasons included.
          expect(pgOutcomes, `seed=${plan.seed}: postgres ≠ sqlite outcome sequence`).toEqual(sq);
        }
      } finally {
        await driver.close();
      }
    },
    600_000,
  );
});
