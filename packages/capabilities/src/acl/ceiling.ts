/**
 * Doc-read ceiling resolver — the SOLE row-level read authority
 * (ADR 0040 Step 6; architecture.md §8.1 Layer 1's ceiling algebra).
 *
 * Implements `who-can-read(X)` for docs:
 *
 *     who-can-read(X) =
 *       (X.access_mode = 'space'
 *          ? Space-baseline-members(X.space)
 *          : ∅)                              -- 'private': no baseline term
 *       ∪ { created_by(X) }                  -- implicit permanent owner
 *       ∪ explicit-grants(X)                 -- grants rows on the doc
 *       ∪ space-grants(X.space)              -- grants rows on the Space
 *                                            --   ('space' mode only)
 *
 * **Mechanism (F88 / H4 / H10).** This is the handler-deny channel the
 * ADR committed to: handlers call the resolver post-parse with `ctx.db`
 * and throw `PermissionDeniedError` — the dispatcher's F88 catch turns
 * that into a deny audit row. There is NO pre-handler AccessPath
 * codegen and the permission gate stays row-blind; surfaces never
 * re-implement any of this (invariant 5).
 *
 * **Local lookup, never a graph walk.** The resolver issues at most
 * four single-table indexed SELECTs (collections, spaces,
 * space_members, grants — all auto-workspace-scoped by the tenant
 * plugin) and then evaluates docs purely in memory. A doc's Space is
 * ONE denormalized hop: `doc.collection_id → collections.space_id`.
 * Nested collections do NOT chain — the Step-7/8 placement
 * capabilities must maintain `space_id` denormalized on every
 * collection row (recorded as a binding obligation in the ADR's
 * Step-6 amendment); the resolver refusing to walk `parent_id` is
 * what makes that invariant load-bearing rather than decorative.
 *
 * **NULL-space = workspace-legacy baseline (designed), dangling ref =
 * fail closed (anomaly).** Pre-Step-7/8 data has no doc→Space linkage:
 * root docs (`collection_id IS NULL`) and unspaced collections
 * (`space_id IS NULL`) are the DESIGNED legacy state — the pre-Spaces
 * world where Layer-2 workspace scoping + the scope gate were the only
 * read controls — so every workspace principal reads them and Step 6
 * lands with zero observable narrowing on live data. A `collection_id`
 * pointing at a missing collections row, or a `space_id` pointing at a
 * missing or soft-deleted spaces row, is NOT a designed state: those
 * fail closed (creator + doc-grants only). Referential anomalies must
 * never widen a read set.
 *
 * **'private' mode is creator + doc-grants only.** The formula's
 * baseline term vanishes and so does the space-grant term: a Space-
 * level grant is baseline-tier reach (like membership), and private
 * mode exists precisely to cut baseline-tier reach. Only an explicit
 * grant ON THE DOC (guest or not) crosses into a private doc.
 *
 * **Open-space baseline is for users only.** `spaces.baseline_access`
 * is "the implicit GrantRole an open space confers on Org members
 * holding no membership row" (Step-4 DDL comment). Agents are
 * principals, not Org members — a non-delegated agent reads spaced
 * docs only via explicit grants. For READ purposes the
 * `baseline_access` VALUE is irrelevant (every GrantRole ≥ view);
 * it starts mattering on the Step-8 write-side ladder.
 *
 * **No workspace-role bypass.** Workspace owner/admin roles do NOT
 * override the ceiling — ADR 0040's formula has no admin term, and
 * scenario 3 (each member keeps a Personal space for private drafts)
 * is only true if it holds against admins too. Roles gate which
 * CAPABILITIES a principal may call (scope gate); the ceiling gates
 * which ROWS those capabilities reach.
 *
 * **Delegated agents evaluate as their delegator.** For an
 * `acting_as` token the ceiling subject is the DELEGATOR's user
 * identity (memberships, grants, created_by — everything); the
 * agent's OWN grants are deliberately ignored while delegated, since
 * `agent ∪ delegator` would let a delegated token read MORE than the
 * user it acts for — the opposite of the H8 intersection posture the
 * gate applies to scopes. A non-delegated agent evaluates as itself:
 * grants with `subject_kind = 'agent'`, no memberships, no baselines.
 *
 * **Guest grants (is_guest = 1) read identically to explicit grants
 * here.** In v1's single Org a guest grantee is still a same-workspace
 * principal, so the tenant plugin never blocks the row and the union
 * term above is the whole story (ADR 0040 fork #2 — the dedicated
 * audited cross-workspace guest read path is reserved for multi-Org,
 * not built).
 *
 * **Soft-deleted collections still bind.** The collections preload
 * includes trashed rows: a doc inside a trashed collection keeps its
 * Space binding for `doc.restore`'s ceiling check; collection
 * lifecycle is a navigation concern, not an ACL one (B1).
 *
 * ── Granting authority (ADR 0040 Step 8) ──────────────────────────────
 *
 * Beside the read predicate the resolver carries the GRANTING-authority
 * ladder — "may this principal manage grants on X" — for the
 * `permission.*` capabilities (and later `space.*`). Same posture as
 * `canPlaceIn`: the scope gate (`permission:grant`) is coarse; THIS is
 * the per-resource authority, and it lives here so no surface
 * re-derives it (invariant 5).
 *
 * The ladder, per resource:
 *
 *   - **Doc owner-tier** — `created_by` (the implicit permanent owner)
 *     or a NON-guest `owner`-role grant on the doc. Guest grants never
 *     confer authority regardless of role ("can't be re-shared" —
 *     bounded blast radius, ADR 0040 scenario 7).
 *   - **Space owner-tier** — for a doc, via its placement; for a Space
 *     resource, directly. PERSONAL spaces: the `owner_user_id` ONLY —
 *     deliberately excluding workspace owner/admin and any grant row,
 *     because personal-space privacy is only real if it holds against
 *     admins (the scenario-3 pin; admins see the FORENSIC record via
 *     audit — see-all-by-design — but cannot quietly re-key personal
 *     access). TEAM spaces: an `owner`-role space MEMBERSHIP, a
 *     non-guest `owner`-role space GRANT, or the workspace owner/admin
 *     backstop (org management — a workspace admin administers team
 *     structure without joining every team).
 *   - **Legacy placements** (the pre-Spaces world): doc owner-tier or
 *     the workspace owner/admin backstop.
 *   - **Anomaly placements**: doc owner-tier only — a dangling ref
 *     never widens authority, mirroring the read posture.
 *
 * **The workspace-admin backstop is USER-principal-only.** A delegated
 * agent evaluates doc/space terms as its delegator (same identity
 * collapse as reads), but the resolver cannot see the delegator's
 * workspace roles (the gate owns role loading), so the admin backstop
 * fails closed for ALL agent principals — an admin-delegated agent
 * still administers what the admin created/owns via the identity
 * terms, it just cannot wield the org-wide backstop. Recorded in the
 * ADR Step-8 amendment.
 */

import type { TenantScopedDb } from "@editorzero/db";
import { PermissionDeniedError } from "@editorzero/errors";
import type { CollectionId, DocId, SpaceId, UserId } from "@editorzero/ids";
import { isDelegated, type Principal } from "@editorzero/principal";
import type { AccessMode, GrantRole, SpaceKind, SpaceType } from "@editorzero/scopes";

/**
 * The doc fields the ceiling evaluates. Structural — handlers pass the
 * richer rows they already SELECTed (they must include `created_by`,
 * which reads add to their column list for exactly this purpose).
 */
export interface CeilingDocRow {
  readonly id: DocId;
  readonly created_by: UserId;
  readonly access_mode: AccessMode;
  readonly collection_id: CollectionId | null;
}

/**
 * Resolved Space binding of a placement (`collection_id`, nullable).
 * `legacy` = the designed pre-Spaces state (root, or a collection with
 * `space_id IS NULL`) — workspace-baseline semantics. `anomaly` = a
 * dangling collection ref, dangling space ref, or soft-deleted space —
 * always fail-closed. `space` = a live Space binding.
 */
export type Placement =
  | { readonly kind: "legacy" }
  | { readonly kind: "space"; readonly space_id: SpaceId }
  | { readonly kind: "anomaly" };

export interface DocReadResolver {
  /** Pure in-memory evaluation against the preloaded ACL state. */
  canRead(doc: CeilingDocRow): boolean;
  /**
   * F88 deny channel: throws `PermissionDeniedError` with the
   * pre-reserved `acl_deny` reason. The dispatcher audits it as a
   * deny row (`reason_code: "acl_deny"`); HTTP projects 403.
   */
  assertCanRead(doc: CeilingDocRow): void;
  /** Resolve a placement's Space bucket (in-memory, no extra query). */
  placementOf(collection_id: CollectionId | null): Placement;
  /**
   * The placement's STORED space ref when the spaces row still exists —
   * live or trashed — `null` for root, unspaced collections, and
   * dangling refs (missing collection row / missing spaces row). The
   * forensic sibling of `placementOf`: where `placementOf` collapses a
   * trashed-space binding to `anomaly` (fail-closed authority), this
   * answers "what did the stored ref say" for audit honesty —
   * `doc.move`'s `acl_transition.before_space_id` on a repair move.
   * Same preloaded snapshot as `placementOf`, so the two can't skew.
   */
  storedSpaceRefOf(collection_id: CollectionId | null): SpaceId | null;
  /**
   * Placement authority — may this principal put a doc INTO this
   * placement (Codex Step-6 HIGH 1)? This is the BASELINE-reach term
   * of the read union only: Space membership, a Space-level grant, or
   * the open-space Org baseline (user subjects). No `created_by` /
   * doc-grant terms — there is no doc yet. `legacy` placements are
   * always placeable (the pre-Spaces world); `anomaly` never is.
   */
  canPlaceIn(collection_id: CollectionId | null): boolean;
  /** F88 projection of `canPlaceIn` — `acl_deny` scoped to the collection. */
  assertCanPlaceIn(collection_id: CollectionId): void;
  /**
   * Granting authority on a doc (see header ladder): doc owner-tier,
   * else by placement — space owner-tier / legacy admin backstop /
   * anomaly fail-closed.
   */
  canAdministerDoc(doc: CeilingDocRow): boolean;
  /** F88 projection of `canAdministerDoc` — `acl_deny` scoped to the doc. */
  assertCanAdministerDoc(doc: CeilingDocRow): void;
  /**
   * Granting authority on a Space resource: personal → `owner_user_id`
   * only; team → owner-role membership, non-guest owner-role space
   * grant, or the workspace owner/admin backstop. Missing or
   * soft-deleted spaces are never administerable (404 is the handler's
   * job — this predicate just fails closed).
   */
  canAdministerSpace(space_id: SpaceId): boolean;
  /** F88 projection of `canAdministerSpace` — `acl_deny` scoped to the space. */
  assertCanAdministerSpace(space_id: SpaceId): void;
  /**
   * Restore authority on a space — the ONE sanctioned dead-row
   * evaluation of the administer ladder (`space.restore`'s authority
   * predicate; ADR 0040 slice-1 deliberately refused to bypass
   * `canAdministerSpace`'s liveness gate for revoke, and that stands —
   * this predicate exists so restore itself never has to). Same ladder
   * body as `canAdministerSpace` minus the liveness gate AND minus the
   * membership rung (Step-8 slice-2 Codex review NOTE: `space.archive`
   * refuses while ANY roster row exists, so owner-role membership
   * cannot legitimately survive onto a dead team space — a row found
   * there is corrupt, and corrupt state must not confer restore
   * authority): personal → `owner_user_id`; team → non-guest
   * owner-role space grant (grants RIDE through archive, H1) / the
   * admin backstop. Missing spaces are still false; intent-named so it
   * cannot be mistaken for a general trashed-space authority hatch.
   */
  canRestoreSpace(space_id: SpaceId): boolean;
  /** F88 projection of `canRestoreSpace` — `acl_deny` scoped to the space. */
  assertCanRestoreSpace(space_id: SpaceId): void;
  /**
   * Baseline-reach probe on a live space (membership / space grant /
   * open-space user baseline) — the same term `canRead`'s space mode
   * and `canPlaceIn` use, exposed for `permission.list`'s space-side
   * visibility rule. False for missing/soft-deleted spaces.
   */
  hasBaselineReach(space_id: SpaceId): boolean;
  /**
   * F88 projection of `hasBaselineReach` — `acl_deny` scoped to the
   * space. The placement-standing assert for verbs that target a SPACE
   * bucket directly rather than through an existing collection
   * (`collection.create(space_id)` — the space-collection family).
   * Exactly the `assertCanPlaceIn` term one level up: agents do NOT
   * ride the open-space user baseline (they need an explicit space
   * grant, or a delegator with reach), and missing/soft-deleted spaces
   * fail closed (the 404 surface is the handler's job, before this).
   */
  assertCanPlaceInSpace(space_id: SpaceId): void;
}

/**
 * The identity the ceiling evaluates for — see header: delegated
 * agents collapse to their delegator's user identity.
 */
type CeilingSubject =
  | { readonly kind: "user"; readonly user_id: UserId }
  | { readonly kind: "agent"; readonly agent_id: string };

function ceilingSubject(principal: Principal): CeilingSubject {
  if (principal.kind === "user") return { kind: "user", user_id: principal.id };
  if (isDelegated(principal)) return { kind: "user", user_id: principal.acting_as };
  return { kind: "agent", agent_id: principal.id };
}

/**
 * Preload the principal's ACL state (≤ 4 indexed, plugin-scoped
 * SELECTs) and return the evaluator. Load once per request, evaluate
 * any number of docs — `doc.list` filters its whole result set through
 * one resolver; single-doc handlers assert on the row they fetched.
 *
 * Called with `ctx.db` wherever the handler runs: for metadata-only
 * capabilities that is INSIDE the dispatcher tx (the preload reads the
 * tx snapshot — consistent by construction; the metadata-only
 * atomicity pin counts these SELECTs deterministically), for content
 * capabilities and reads it is the plain scoped handle.
 */
export async function loadDocReadResolver(
  db: TenantScopedDb,
  principal: Principal,
): Promise<DocReadResolver> {
  const subject = ceilingSubject(principal);

  const collectionRows = await db.selectFrom("collections").select(["id", "space_id"]).execute();
  const collectionSpace = new Map<CollectionId, SpaceId | null>(
    collectionRows.map((r) => [r.id, r.space_id]),
  );

  const spaceRows = await db
    .selectFrom("spaces")
    .select(["id", "kind", "type", "owner_user_id", "deleted_at"])
    .execute();
  const spaces = new Map<
    SpaceId,
    {
      kind: SpaceKind;
      type: SpaceType;
      owner_user_id: UserId | null;
      deleted_at: number | null;
    }
  >(
    spaceRows.map((r) => [
      r.id,
      { kind: r.kind, type: r.type, owner_user_id: r.owner_user_id, deleted_at: r.deleted_at },
    ]),
  );

  // Same single per-subject query as before, now carrying `role` so the
  // authority ladder can tell an owner-membership from the rest.
  const memberSpaceRole = new Map<SpaceId, GrantRole>();
  if (subject.kind === "user") {
    const memberRows = await db
      .selectFrom("space_members")
      .select(["space_id", "role"])
      .where("user_id", "=", subject.user_id)
      .execute();
    for (const r of memberRows) memberSpaceRole.set(r.space_id, r.role);
  }

  const grantRows = await db
    .selectFrom("grants")
    .select(["resource_kind", "resource_id", "role", "is_guest"])
    .where("subject_kind", "=", subject.kind)
    .where("subject_id", "=", subject.kind === "user" ? subject.user_id : subject.agent_id)
    .execute();
  // Read sets: EVERY grant reads (guest or not, any role).
  const docGrantIds = new Set<string>();
  const spaceGrantIds = new Set<string>();
  // Authority sets: only NON-guest `owner`-role grants confer it
  // (guest grants are deliberately re-share-proof — scenario 7).
  const docOwnerGrantIds = new Set<string>();
  const spaceOwnerGrantIds = new Set<string>();
  for (const r of grantRows) {
    if (r.resource_kind === "doc") {
      docGrantIds.add(r.resource_id);
      if (r.role === "owner" && r.is_guest === 0) docOwnerGrantIds.add(r.resource_id);
    } else {
      spaceGrantIds.add(r.resource_id);
      if (r.role === "owner" && r.is_guest === 0) spaceOwnerGrantIds.add(r.resource_id);
    }
  }

  // Workspace owner/admin backstop — USER principals only (see header:
  // the resolver cannot see a delegator's workspace roles, so the
  // backstop fails closed for every agent principal, delegated or not).
  const adminTier =
    principal.kind === "user" && principal.roles.some((r) => r === "owner" || r === "admin");

  // The single binding spec of "where does this placement live" — both
  // the read predicate and the placement-authority check resolve
  // through it, so the legacy/anomaly distinction cannot drift apart.
  const placementOf = (collection_id: CollectionId | null): Placement => {
    if (collection_id === null) return { kind: "legacy" }; // root
    const spaceId = collectionSpace.get(collection_id);
    if (spaceId === undefined) return { kind: "anomaly" }; // dangling collection ref
    if (spaceId === null) return { kind: "legacy" }; // unspaced collection
    const space = spaces.get(spaceId);
    if (space === undefined || space.deleted_at !== null) return { kind: "anomaly" };
    return { kind: "space", space_id: spaceId };
  };

  // Baseline reach into a LIVE space: membership / space grant / the
  // open-space Org baseline (user subjects only — agents are not Org
  // members) / the personal-space owner. The owner term is structural
  // (the spaces CHECK pins `owner_user_id` ⇔ kind='personal'), NOT a
  // convention about seeded membership rows: without it the signup-
  // seeded Personal space would deny its own owner doc placement +
  // space-mode reads the moment no `space_members` row exists.
  const baselineReach = (space_id: SpaceId): boolean => {
    if (spaceGrantIds.has(space_id)) return true;
    if (subject.kind === "user") {
      if (memberSpaceRole.has(space_id)) return true;
      const space = spaces.get(space_id);
      if (space?.type === "open") return true;
      if (space?.owner_user_id === subject.user_id) return true;
    }
    return false;
  };

  // Space owner-tier ladder BODY (the authority ladder's space term —
  // see header). Personal: `owner_user_id` only. Team: owner-role
  // membership / non-guest owner-role space grant / the workspace
  // admin backstop. Liveness is deliberately NOT evaluated here: the
  // live predicate (`spaceOwnerTier`) adds the gate, and
  // `restoreSpaceTier` is the one consumer that evaluates the ladder
  // on a dead row — ONE ladder body, so the two predicates cannot
  // drift.
  //
  // `membershipRung` parameterizes the owner-role `space_members` term
  // (Step-8 slice-2 Codex review NOTE): `space.archive` refuses while
  // ANY roster row exists, so membership cannot legitimately survive
  // onto a dead team space — a roster row found there is corrupt, and
  // corrupt state must not confer restore authority. The live ladder
  // keeps the rung; the dead-row ladder drops it.
  const spaceOwnerTierBody = (space_id: SpaceId, membershipRung: boolean): boolean => {
    const space = spaces.get(space_id);
    if (space === undefined) return false;
    if (space.kind === "personal") {
      return subject.kind === "user" && space.owner_user_id === subject.user_id;
    }
    if (membershipRung && memberSpaceRole.get(space_id) === "owner") return true;
    if (spaceOwnerGrantIds.has(space_id)) return true;
    return adminTier;
  };

  const spaceOwnerTier = (space_id: SpaceId): boolean => {
    const space = spaces.get(space_id);
    if (space === undefined || space.deleted_at !== null) return false;
    return spaceOwnerTierBody(space_id, true);
  };

  const restoreSpaceTier = (space_id: SpaceId): boolean => spaceOwnerTierBody(space_id, false);

  const canAdministerDoc = (doc: CeilingDocRow): boolean => {
    // Doc owner-tier: implicit permanent owner, or a non-guest
    // owner-role grant on the doc.
    if (subject.kind === "user" && doc.created_by === subject.user_id) return true;
    if (docOwnerGrantIds.has(doc.id)) return true;

    const placement = placementOf(doc.collection_id);
    if (placement.kind === "legacy") return adminTier;
    if (placement.kind === "anomaly") return false; // fail closed
    return spaceOwnerTier(placement.space_id);
  };

  const canAdministerSpace = (space_id: SpaceId): boolean => spaceOwnerTier(space_id);

  const canRead = (doc: CeilingDocRow): boolean => {
    // Implicit permanent owner: created_by always reads, both modes,
    // never via a grants row (ADR 0040 — transfer never mutates it).
    if (subject.kind === "user" && doc.created_by === subject.user_id) return true;
    // Explicit doc grant (guest or not) reads in both modes.
    if (docGrantIds.has(doc.id)) return true;

    if (doc.access_mode === "private") return false;

    // access_mode = 'space': resolve the single denormalized hop.
    const placement = placementOf(doc.collection_id);
    if (placement.kind === "legacy") return true; // workspace-legacy baseline
    if (placement.kind === "anomaly") return false; // fail closed
    return baselineReach(placement.space_id);
  };

  const canPlaceIn = (collection_id: CollectionId | null): boolean => {
    const placement = placementOf(collection_id);
    if (placement.kind === "legacy") return true;
    if (placement.kind === "anomaly") return false;
    return baselineReach(placement.space_id);
  };

  const hasBaselineReach = (space_id: SpaceId): boolean => {
    const space = spaces.get(space_id);
    if (space === undefined || space.deleted_at !== null) return false;
    return baselineReach(space_id);
  };

  return {
    canRead,
    assertCanRead: (doc) => {
      if (!canRead(doc)) {
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { doc_id: doc.id } },
        });
      }
    },
    placementOf,
    storedSpaceRefOf: (collection_id) => {
      if (collection_id === null) return null;
      const spaceId = collectionSpace.get(collection_id);
      if (spaceId === undefined || spaceId === null) return null;
      return spaces.has(spaceId) ? spaceId : null;
    },
    canPlaceIn,
    assertCanPlaceIn: (collection_id) => {
      if (!canPlaceIn(collection_id)) {
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { collection_id } },
        });
      }
    },
    canAdministerDoc,
    assertCanAdministerDoc: (doc) => {
      if (!canAdministerDoc(doc)) {
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { doc_id: doc.id } },
        });
      }
    },
    canAdministerSpace,
    assertCanAdministerSpace: (space_id) => {
      if (!canAdministerSpace(space_id)) {
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { space_id } },
        });
      }
    },
    canRestoreSpace: restoreSpaceTier,
    assertCanRestoreSpace: (space_id) => {
      if (!restoreSpaceTier(space_id)) {
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { space_id } },
        });
      }
    },
    hasBaselineReach,
    assertCanPlaceInSpace: (space_id) => {
      if (!hasBaselineReach(space_id)) {
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { space_id } },
        });
      }
    },
  };
}
