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
 */

import type { TenantScopedDb } from "@editorzero/db";
import { PermissionDeniedError } from "@editorzero/errors";
import type { CollectionId, DocId, SpaceId, UserId } from "@editorzero/ids";
import { isDelegated, type Principal } from "@editorzero/principal";
import type { AccessMode, SpaceType } from "@editorzero/scopes";

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

  const spaceRows = await db.selectFrom("spaces").select(["id", "type", "deleted_at"]).execute();
  const spaces = new Map<SpaceId, { type: SpaceType; deleted_at: number | null }>(
    spaceRows.map((r) => [r.id, { type: r.type, deleted_at: r.deleted_at }]),
  );

  const memberSpaceIds = new Set<SpaceId>();
  if (subject.kind === "user") {
    const memberRows = await db
      .selectFrom("space_members")
      .select("space_id")
      .where("user_id", "=", subject.user_id)
      .execute();
    for (const r of memberRows) memberSpaceIds.add(r.space_id);
  }

  const grantRows = await db
    .selectFrom("grants")
    .select(["resource_kind", "resource_id"])
    .where("subject_kind", "=", subject.kind)
    .where("subject_id", "=", subject.kind === "user" ? subject.user_id : subject.agent_id)
    .execute();
  const docGrantIds = new Set<string>();
  const spaceGrantIds = new Set<string>();
  for (const r of grantRows) {
    if (r.resource_kind === "doc") docGrantIds.add(r.resource_id);
    else spaceGrantIds.add(r.resource_id);
  }

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
  // members).
  const baselineReach = (space_id: SpaceId): boolean => {
    if (spaceGrantIds.has(space_id)) return true;
    if (subject.kind === "user") {
      if (memberSpaceIds.has(space_id)) return true;
      if (spaces.get(space_id)?.type === "open") return true;
    }
    return false;
  };

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
    canPlaceIn,
    assertCanPlaceIn: (collection_id) => {
      if (!canPlaceIn(collection_id)) {
        throw new PermissionDeniedError({
          reason: { kind: "acl_deny", scope: { collection_id } },
        });
      }
    },
  };
}
