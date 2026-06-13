/**
 * Invariant 3a — "the audit log alone reconstructs final persistent state."
 *
 * The integration property that proves it END-TO-END against the REAL
 * dispatcher (ADR 0040 build-order step 2; #23). `packages/audit`'s unit
 * tests pin the reducer against hand-written effects; this suite instead
 * DRIVES the real capabilities and asserts that whatever effects their
 * handlers actually emit replay back to the live database. The gap between
 * "what the handler wrote" and "what the effect carried" is exactly the
 * `doc.rename` slug drop (#25): the handler wrote `docs.slug`, the effect
 * didn't carry it, so the replayed slug stayed stale while the DB advanced.
 * A unit test against a hand-written effect can't see that gap; this can.
 *
 * Shape:
 *   1. A recording `AuditWriter` wraps the real `createAuditWriter` — it
 *      performs the real `audit_events` + `outbox(audit.appended)` INSERT
 *      AND captures the typed `AuditWriteInput`. The captured `record` IS
 *      the typed `AuditRecord` (no `effect`-column JSON is ever narrowed
 *      back to `AuditEffect` — no cast); a `ReplayRow` is built directly
 *      from its fields.
 *   2. Every shipped state-class mutation capability is dispatched through
 *      the real `createDispatcher` against a real in-memory SQLite driver.
 *   3. After EACH dispatch, `replay([...genesis, ...captured])` is deep-
 *      equal-compared to a `PersistentWorkspaceState` projected from the
 *      live `workspaces` / `workspace_members` / `collections` / `docs`
 *      columns. Per-step (not just end-state) so a drift pinpoints the
 *      exact capability whose effect diverged from its handler's write.
 *
 * **Genesis (ADR 0041).** Signup writes the root `workspaces` row + the
 * owner `workspace_members` row via the post-commit bootstrap, emitting
 * `workspace.create` + `member.add` under the `system.workspace_bootstrap`
 * marker. This dispatcher-level harness doesn't run the signup hook, so it
 * SEEDS those two rows directly AND prepends the two matching genesis
 * `ReplayRow`s (derived from the same constants) — modeling exactly what the
 * bootstrap emits, so the replay baseline already contains the workspace
 * that `workspace.update` later patches (a patch against an absent workspace
 * would be a silent no-op).
 *
 * **Metadata / content boundary (3a vs 3b).** The property reconstructs the
 * METADATA spine only. `doc.create` / `doc.rename` write their metadata
 * columns through `ctx.db` (the rows under test) and THEN seed/patch the
 * Y.Doc title block through `ctx.transact` (CRDT content — invariant 3b, the
 * snapshot-projection job's concern, not the reducer's). The harness supplies
 * a no-op `transact`: the metadata writes stay fully real while the BlockNote
 * content step never runs (no DOM shim, no sync wiring). This is the concrete
 * meaning of "compare `docs.title` only under metadata-only sequences" — no
 * free-form `doc.update` content edit interleaves to mutate the title block
 * out-of-band, which would drift `docs.title` from the metadata effects.
 *
 * **Deferred-kind guard (anti-ossification).** After the walk, every effect a
 * shipped capability actually emitted is asserted NOT to be classified
 * `"deferred"` in `REPLAY_CLASS`. A shipped capability emitting a deferred
 * kind is a classification bug — the kind must be reclassified to
 * `state`/`content` and given a transition + coverage, not left a silent
 * no-op. A coverage assertion then pins that the sequence really did exercise
 * every shipped state-class effect it intends to, so a future refactor can't
 * quietly drop one.
 */

import {
  type AgentState,
  type AgentTokenState,
  type AuditEffect,
  type AuditWriteInput,
  type AuditWriter,
  type CollectionState,
  type DocState,
  type GrantState,
  type MemberState,
  memberKey,
  type PersistentWorkspaceState,
  REPLAY_CLASS,
  type ReplayRow,
  replay,
  type SpaceMemberState,
  type SpaceState,
  spaceMemberKey,
  type WorkspaceState,
} from "@editorzero/audit";
import {
  collectionCreate,
  collectionDelete,
  collectionMove,
  collectionRestore,
  collectionUpdate,
  createRegistry,
  docAddGuest,
  docCreate,
  docDelete,
  docMove,
  docPublish,
  docRemoveGuest,
  docRename,
  docRestore,
  docUnpublish,
  permissionGrant,
  permissionRevoke,
  registerCapability,
  spaceArchive,
  spaceCreate,
  spaceMemberAdd,
  spaceMemberRemove,
  spaceMemberUpdateRole,
  spaceRestore,
  spaceUpdate,
  workspaceMemberAdd,
  workspaceMemberRemove,
  workspaceMemberUpdateRole,
  workspaceUpdate,
} from "@editorzero/capabilities";
import {
  asAuditTx,
  createAuditWriter,
  createSqliteDriver,
  createTenantScopedDb,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { type CapabilityId, CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AccessPath, UserPrincipal } from "@editorzero/principal";
import { SCOPES, type Scope } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { CapabilityContextExtras } from "../src/index";
import { createDispatcher, scopeOnlyGate } from "../src/index";

// ── Fixtures ───────────────────────────────────────────────────────────────

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const OWNER = UserId("018f0000-0000-7000-8000-000000000002");
const SECOND_USER = UserId("018f0000-0000-7000-8000-000000000003");
// Never seeded as a workspace member — `doc.add_guest` performs no
// subject standing checks (the verb's point), so the walk can mint a
// guest edge for an out-of-workspace subject.
const GUEST_USER = UserId("018f0000-0000-7000-8000-000000000004");

// Genesis values — used for BOTH the direct DB seed and the prepended genesis
// `ReplayRow`s, so the two cannot drift (single source).
const GENESIS_SLUG = "genesis-workspace";
const GENESIS_NAME = "Genesis Workspace";
const GENESIS_RETENTION = 30;

function ownerPrincipal(): UserPrincipal {
  return {
    kind: "user",
    id: OWNER,
    workspace_id: WORKSPACE_ID,
    // Owner holds every scope, so a single principal can drive the whole
    // mutation surface without per-capability role juggling.
    roles: ["owner"],
    session_id: null,
    token_id: null,
  };
}

function ownerAccess(): AccessPath {
  return { workspace_id: WORKSPACE_ID };
}

/**
 * The two audit rows the ADR 0041 signup bootstrap emits, modeled here so the
 * replay baseline matches the directly-seeded genesis rows. `principal_id` is
 * the owner (a `UserId` is a `string`); the effects carry exactly what the
 * bootstrap writer carries (settings `{}`, retention 30, role `owner`).
 */
const GENESIS_ROWS: readonly ReplayRow[] = [
  {
    principal_kind: "user",
    principal_id: OWNER,
    record: {
      outcome: "allow",
      effect: {
        kind: "workspace.create",
        workspace_id: WORKSPACE_ID,
        slug: GENESIS_SLUG,
        name: GENESIS_NAME,
        created_by: OWNER,
        trash_retention_days: GENESIS_RETENTION,
        settings: {},
      },
    },
  },
  {
    principal_kind: "user",
    principal_id: OWNER,
    record: {
      outcome: "allow",
      effect: { kind: "member.add", workspace_id: WORKSPACE_ID, user_id: OWNER, role: "owner" },
    },
  },
];

// ── Narrowing helpers (no casts) ─────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Pull a minted-id string off a dispatch result. `doc.create` /
 * `collection.create` mint their ids internally (`.strict()` rejects a
 * caller-supplied id), so the only way to thread the new id into the next
 * step is to read it from the handler's return — narrowed via a guard, never
 * a cast. Independent of the audit effect (the thing under test).
 */
function readIdField(result: unknown, key: string): string {
  if (isPlainObject(result)) {
    const value = result[key];
    if (typeof value === "string") return value;
  }
  throw new Error(`dispatch result missing string field "${key}": ${JSON.stringify(result)}`);
}

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

function isScope(value: unknown): value is Scope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

/**
 * Parse the `agent_tokens.scopes` JSON column into the typed form the
 * reducer holds. Unlike `settings` (open object — fallback `{}`), scopes
 * have a CLOSED vocabulary, so a non-conforming value THROWS: it means
 * something wrote the column outside the owned mint path, and silently
 * filtering would hide exactly the drift this property exists to catch.
 */
function parseScopesColumn(json: string): readonly Scope[] {
  const parsed: unknown = JSON.parse(json);
  if (Array.isArray(parsed)) {
    const scopes = parsed.filter(isScope);
    if (scopes.length === parsed.length) return scopes;
  }
  throw new Error(`agent_tokens.scopes is not a Scope[] — written outside the mint path: ${json}`);
}

/**
 * Project the live DB into the same `PersistentWorkspaceState` the reducer
 * reconstructs — the right-hand side of the invariant-3a equality. Scoped to
 * the one workspace under test. Deliberately selects ONLY the projected
 * columns: `created_at` / `updated_at` / `diagnostic_salt` /
 * `render_version` are excluded by construction (see `@editorzero/audit`
 * state.ts — they are not audit-reconstructable / are derivable
 * bookkeeping), and `settings` is parsed to the object form the reducer
 * holds.
 */
async function projectFromDb(d: SqliteDriver, ws: WorkspaceId): Promise<PersistentWorkspaceState> {
  const sys = d.system();

  const workspaces: Record<string, WorkspaceState> = {};
  for (const r of await sys
    .selectFrom("workspaces")
    .select(["id", "slug", "name", "trash_retention_days", "settings", "created_by", "deleted_at"])
    .where("id", "=", ws)
    .execute()) {
    const parsed: unknown = JSON.parse(r.settings);
    workspaces[r.id] = {
      id: r.id,
      slug: r.slug,
      name: r.name,
      trash_retention_days: r.trash_retention_days,
      settings: isPlainObject(parsed) ? parsed : {},
      created_by: r.created_by,
      deleted_at: r.deleted_at,
    };
  }

  const members: Record<string, MemberState> = {};
  for (const r of await sys
    .selectFrom("workspace_members")
    .select(["workspace_id", "user_id", "role", "deleted_at"])
    .where("workspace_id", "=", ws)
    .execute()) {
    members[memberKey(r.workspace_id, r.user_id)] = {
      workspace_id: r.workspace_id,
      user_id: r.user_id,
      role: r.role,
      deleted_at: r.deleted_at,
    };
  }

  const collections: Record<string, CollectionState> = {};
  for (const r of await sys
    .selectFrom("collections")
    .select([
      "id",
      "workspace_id",
      "parent_id",
      "space_id",
      "title",
      "slug",
      "order_key",
      "created_by",
      "deleted_at",
    ])
    .where("workspace_id", "=", ws)
    .execute()) {
    collections[r.id] = {
      id: r.id,
      workspace_id: r.workspace_id,
      parent_id: r.parent_id,
      space_id: r.space_id,
      title: r.title,
      slug: r.slug,
      order_key: r.order_key,
      created_by: r.created_by,
      deleted_at: r.deleted_at,
    };
  }

  const docs: Record<string, DocState> = {};
  for (const r of await sys
    .selectFrom("docs")
    .select([
      "id",
      "workspace_id",
      "collection_id",
      "title",
      "slug",
      "order_key",
      "access_mode",
      "published_slug",
      "published_at",
      "created_by",
      "deleted_at",
    ])
    .where("workspace_id", "=", ws)
    .execute()) {
    docs[r.id] = {
      id: r.id,
      workspace_id: r.workspace_id,
      collection_id: r.collection_id,
      title: r.title,
      slug: r.slug,
      order_key: r.order_key,
      access_mode: r.access_mode,
      published_slug: r.published_slug,
      published_at: r.published_at,
      created_by: r.created_by,
      deleted_at: r.deleted_at,
    };
  }

  // ADR 0040 Step-4 tables. No effect kind writes them yet (Step 7), so
  // these projections are provably empty until then — but selecting them
  // keeps the deep-equal honest the moment a fixture (or a bug) touches
  // the live tables ahead of their effects.
  const spaces: Record<string, SpaceState> = {};
  for (const r of await sys
    .selectFrom("spaces")
    .select([
      "id",
      "workspace_id",
      "kind",
      "type",
      "owner_user_id",
      "name",
      "slug",
      "baseline_access",
      "created_by",
      "deleted_at",
    ])
    .where("workspace_id", "=", ws)
    .execute()) {
    spaces[r.id] = {
      id: r.id,
      workspace_id: r.workspace_id,
      kind: r.kind,
      type: r.type,
      owner_user_id: r.owner_user_id,
      name: r.name,
      slug: r.slug,
      baseline_access: r.baseline_access,
      created_by: r.created_by,
      deleted_at: r.deleted_at,
    };
  }

  const space_members: Record<string, SpaceMemberState> = {};
  for (const r of await sys
    .selectFrom("space_members")
    .select(["workspace_id", "space_id", "user_id", "role"])
    .where("workspace_id", "=", ws)
    .execute()) {
    space_members[spaceMemberKey(r.space_id, r.user_id)] = {
      workspace_id: r.workspace_id,
      space_id: r.space_id,
      user_id: r.user_id,
      role: r.role,
    };
  }

  const grants: Record<string, GrantState> = {};
  for (const r of await sys
    .selectFrom("grants")
    .select([
      "id",
      "workspace_id",
      "resource_kind",
      "resource_id",
      "subject_kind",
      "subject_id",
      "role",
      "is_guest",
      "created_by",
    ])
    .where("workspace_id", "=", ws)
    .execute()) {
    grants[r.id] = {
      id: r.id,
      workspace_id: r.workspace_id,
      resource_kind: r.resource_kind,
      resource_id: r.resource_id,
      subject_kind: r.subject_kind,
      subject_id: r.subject_id,
      role: r.role,
      is_guest: r.is_guest,
      created_by: r.created_by,
    };
  }

  // ADR 0044 tables — same posture as the Step-4 block above: no shipped
  // capability writes them until increment 3, so these are provably empty
  // today, but selecting them keeps the deep-equal honest the moment
  // anything touches the live tables ahead of their effects. The token
  // SELECT deliberately omits `token_hash` (boundary item 2: secrets are
  // material, not state — the projection must never hold it).
  const agents: Record<string, AgentState> = {};
  for (const r of await sys
    .selectFrom("agents")
    .select(["id", "workspace_id", "name", "owner_user_id", "created_by", "revoked_at"])
    .where("workspace_id", "=", ws)
    .execute()) {
    agents[r.id] = {
      id: r.id,
      workspace_id: r.workspace_id,
      name: r.name,
      owner_user_id: r.owner_user_id,
      created_by: r.created_by,
      revoked_at: r.revoked_at,
    };
  }

  const agent_tokens: Record<string, AgentTokenState> = {};
  for (const r of await sys
    .selectFrom("agent_tokens")
    .select([
      "id",
      "workspace_id",
      "agent_id",
      "token_prefix",
      "last4",
      "scopes",
      "tier",
      "expires_at",
      "created_by",
      "revoked_at",
    ])
    .where("workspace_id", "=", ws)
    .execute()) {
    agent_tokens[r.id] = {
      id: r.id,
      workspace_id: r.workspace_id,
      agent_id: r.agent_id,
      token_prefix: r.token_prefix,
      last4: r.last4,
      scopes: parseScopesColumn(r.scopes),
      tier: r.tier,
      expires_at: r.expires_at,
      created_by: r.created_by,
      revoked_at: r.revoked_at,
    };
  }

  return {
    workspaces,
    members,
    collections,
    docs,
    spaces,
    space_members,
    grants,
    agents,
    agent_tokens,
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

describe("invariant 3a — real dispatch → replay → live-DB projection", () => {
  it("reconstructs the live projection after every metadata mutation", async () => {
    // ── Genesis: seed the workspace + owner directly (the signup hook isn't
    //    in scope at the dispatcher layer). GENESIS_ROWS models the two audit
    //    rows the ADR 0041 bootstrap would have emitted, from the same values.
    const genesisTick = 0;
    await driver
      .system()
      .insertInto("workspaces")
      .values({
        id: WORKSPACE_ID,
        slug: GENESIS_SLUG,
        name: GENESIS_NAME,
        trash_retention_days: GENESIS_RETENTION,
        diagnostic_salt: new Uint8Array(16),
        created_by: OWNER,
        created_at: genesisTick,
        deleted_at: null,
        settings: "{}",
      })
      .execute();
    await driver
      .system()
      .insertInto("workspace_members")
      .values({
        workspace_id: WORKSPACE_ID,
        user_id: OWNER,
        role: "owner",
        created_at: genesisTick,
        updated_at: genesisTick,
        deleted_at: null,
      })
      .execute();

    // ── Recording dispatcher. One monotonic clock feeds both the dispatcher
    //    (handler `ctx.now()` — the value written to `deleted_at`) and the
    //    audit writer (`audit_events.created_at` ordering). The recording
    //    writer performs the real INSERT then captures the typed input.
    let clock = genesisTick;
    const now = () => {
      clock += 1;
      return clock;
    };
    const captured: AuditWriteInput[] = [];
    const realWriter = createAuditWriter(now);
    const recordingWriter: AuditWriter = {
      write: async (tx, input) => {
        await realWriter.write(tx, input);
        captured.push(input);
      },
    };

    const registry = createRegistry([
      registerCapability(workspaceUpdate),
      registerCapability(workspaceMemberAdd),
      registerCapability(workspaceMemberUpdateRole),
      registerCapability(workspaceMemberRemove),
      registerCapability(collectionCreate),
      registerCapability(collectionUpdate),
      registerCapability(collectionMove),
      registerCapability(collectionDelete),
      registerCapability(collectionRestore),
      registerCapability(docAddGuest),
      registerCapability(docCreate),
      registerCapability(docRename),
      registerCapability(docMove),
      registerCapability(docPublish),
      registerCapability(docUnpublish),
      registerCapability(docDelete),
      registerCapability(docRemoveGuest),
      registerCapability(docRestore),
      registerCapability(permissionGrant),
      registerCapability(permissionRevoke),
      registerCapability(spaceArchive),
      registerCapability(spaceCreate),
      registerCapability(spaceMemberAdd),
      registerCapability(spaceMemberRemove),
      registerCapability(spaceMemberUpdateRole),
      registerCapability(spaceRestore),
      registerCapability(spaceUpdate),
    ]);

    const dispatcher = createDispatcher({
      registry,
      gate: scopeOnlyGate(),
      auditWriter: recordingWriter,
      tracer: noopTracer,
      logger: noopLogger,
      now,
      runInWriteTx: async (principal, fn) =>
        driver.withSystemTx(async (tx) => {
          const extras: CapabilityContextExtras = {
            db: createTenantScopedDb(tx, principal.workspace_id),
            outbox: () => {
              /* projection jobs are not exercised by the metadata-replay property */
            },
            // Ephemeral content seam (invariant 3b boundary). `doc.create` /
            // `doc.rename` already wrote their metadata columns via `ctx.db`
            // above; their `ctx.transact` callback seeds/patches the Y.Doc
            // title block (BlockNote — invariant 3b, the snapshot job's
            // concern). We run it against a throwaway `Y.Doc` so the handler
            // completes, then discard it — the metadata-replay property never
            // reads block content. (Every other capability is metadata-only and
            // never calls `transact`.) A non-throwing no-op can't satisfy the
            // generic `<T>(…) => Promise<T>`, so we genuinely invoke `fn`.
            transact: async (_doc_id, fn) => {
              const scratch = new Y.Doc();
              try {
                return await fn(scratch);
              } finally {
                scratch.destroy();
              }
            },
          };
          return fn(extras, asAuditTx(tx));
        }),
      runRead: async (principal, fn) => {
        const extras: CapabilityContextExtras = {
          db: driver.scoped(principal.workspace_id),
          outbox: () => {
            /* reads never enqueue; this property drives mutations only */
          },
          transact: async () => {
            throw new Error("reads must not call ctx.transact");
          },
        };
        return fn(extras);
      },
      withAuditTx: (fn) => driver.withSystemTx((tx) => fn(asAuditTx(tx))),
    });

    // After each dispatch: (1) the capability actually ran AND allowed — a
    // silent deny/error would skip the mutation, write a non-allow row that
    // replay no-ops, and leave `replay == DB` trivially true (masking the
    // skip); (2) replay of [genesis, ...captured] deep-equals the live DB.
    async function step(capability_id: CapabilityId, input: unknown): Promise<unknown> {
      const result = await dispatcher.dispatch({
        capability_id,
        input,
        principal: ownerPrincipal(),
        access: ownerAccess(),
        trace_id: null,
      });
      const last = captured.at(-1);
      expect(last?.record.outcome).toBe("allow");

      const replayRows: ReplayRow[] = [
        ...GENESIS_ROWS,
        ...captured.map((i) => ({
          principal_kind: i.principal_kind,
          principal_id: i.principal_id,
          record: i.record,
        })),
      ];
      expect(replay(replayRows)).toEqual(await projectFromDb(driver, WORKSPACE_ID));
      return result;
    }

    // Baseline: genesis alone reconstructs the seeded workspace + owner.
    expect(replay(GENESIS_ROWS)).toEqual(await projectFromDb(driver, WORKSPACE_ID));

    // ── Walk every shipped state-class mutation. Titles/slugs are kept
    //    distinct so the sibling-slug pre-checks never 409.
    await step(workspaceUpdate.id, {
      name: "Renamed Workspace",
      trash_retention_days: 14,
      settings: { theme: "dark" },
    });

    await step(workspaceMemberAdd.id, { user_id: SECOND_USER, role: "member" });
    await step(workspaceMemberUpdateRole.id, { user_id: SECOND_USER, role: "admin" });

    const c1 = CollectionId(
      readIdField(await step(collectionCreate.id, { title: "Alpha" }), "collection_id"),
    );
    const c2 = CollectionId(
      readIdField(
        await step(collectionCreate.id, { title: "Beta", parent_id: c1 }),
        "collection_id",
      ),
    );
    await step(collectionUpdate.id, { collection_id: c1, title: "Alpha Renamed" });
    await step(collectionMove.id, { collection_id: c2, destination: { kind: "legacy_root" } });

    const d1 = DocId(readIdField(await step(docCreate.id, { title: "Doc One" }), "doc_id"));
    const d2 = DocId(
      readIdField(await step(docCreate.id, { title: "Doc Two", collection_id: c1 }), "doc_id"),
    );
    await step(docRename.id, { doc_id: d1, title: "Doc One Renamed" });
    // Same-bucket move (legacy → legacy) — no `acl_policy`, no
    // transition. The CROSS-boundary branch (`acl_transition` +
    // dropped-grant preimages, ADR 0040 §7) is exercised further down,
    // after the space family mints a space-bound collection THROUGH
    // dispatch (space-collection slice 1).
    await step(docMove.id, { doc_id: d1, new_collection_id: c1 });
    await step(docPublish.id, { doc_id: d1 });
    // Idempotent re-publish: the effect carries the SAME handler-reused
    // pair (URL + original published_at stay stable), so replay equality
    // after this step proves the reducer honours the carried values
    // rather than re-deriving (ADR 0040 Step 5).
    await step(docPublish.id, { doc_id: d1 });
    await step(docUnpublish.id, { doc_id: d1 });
    // Delete-while-published: `doc.soft_delete` must clear the publish
    // pair in BOTH the handler and the reducer (a trashed doc leaves the
    // public site); restore must NOT republish. Publishing d2 first makes
    // these transitions non-trivial (non-null → null).
    await step(docPublish.id, { doc_id: d2 });
    await step(docDelete.id, { doc_id: d2 });
    await step(docRestore.id, { doc_id: d2 });

    await step(collectionDelete.id, { collection_id: c2 });
    await step(collectionRestore.id, { collection_id: c2 });

    // ── ACL edges (ADR 0040 Step 8) — the FIRST real `acl.grant` /
    //    `acl.revoke` emitters, closing the Step-7 deferred obligation.
    //    Both docs sit in legacy placements (no Spaces exist in this
    //    walk), so OWNER's doc owner-tier authorizes and SECOND_USER's
    //    live membership is sufficient standing.
    const g1 = readIdField(
      await step(permissionGrant.id, {
        resource_kind: "doc",
        resource_id: d1,
        subject_kind: "user",
        subject_id: SECOND_USER,
        role: "view",
      }),
      "grant_id",
    );
    // Role convergence re-emits `acl.grant` under the SAME grant_id —
    // replay equality after this step proves the reducer upserts by id
    // (carried values, not re-derivation).
    await step(permissionGrant.id, {
      resource_kind: "doc",
      resource_id: d1,
      subject_kind: "user",
      subject_id: SECOND_USER,
      role: "edit",
    });
    // Idempotent same-role re-grant: an allow row with ZERO row writes —
    // the reducer's upsert must leave the projection converged.
    await step(permissionGrant.id, {
      resource_kind: "doc",
      resource_id: d1,
      subject_kind: "user",
      subject_id: SECOND_USER,
      role: "edit",
    });
    // Hard-DELETE revoke: the effect's full preimage removes the edge.
    await step(permissionRevoke.id, { grant_id: g1 });
    // A second edge that SURVIVES the walk: grants persist through the
    // subject's membership soft-delete below (revocation is explicit;
    // the L1 gate already cuts a removed member's access) — so the
    // final projection compares a NON-EMPTY grants map.
    await step(permissionGrant.id, {
      resource_kind: "doc",
      resource_id: d2,
      subject_kind: "user",
      subject_id: SECOND_USER,
      role: "view",
    });

    // ── Guest family (ADR 0040 Step 8) — the explicit `is_guest = 1`
    //    lane through the SAME `acl.grant` / `acl.revoke` kinds. The
    //    (d1, user, SECOND_USER) edge is free again after the revoke
    //    above, so the lifecycle-conflict rails stay out of the walk's
    //    way. Replay equality across these steps proves the reducer
    //    carries `is_guest` verbatim (mint), converges role under the
    //    same grant_id in the guest lane, holds steady on a zero-write
    //    idempotent re-add, and removes by full preimage.
    await step(docAddGuest.id, {
      doc_id: d1,
      subject_kind: "user",
      subject_id: SECOND_USER,
      role: "view",
    });
    await step(docAddGuest.id, {
      doc_id: d1,
      subject_kind: "user",
      subject_id: SECOND_USER,
      role: "comment",
    });
    await step(docAddGuest.id, {
      doc_id: d1,
      subject_kind: "user",
      subject_id: SECOND_USER,
      role: "comment",
    });
    await step(docRemoveGuest.id, {
      doc_id: d1,
      subject_kind: "user",
      subject_id: SECOND_USER,
    });
    // A guest edge that SURVIVES the walk, minted for a subject who was
    // NEVER a workspace member (no standing checks — the verb's point).
    // d2 now carries one edge per lane, so the final projection compares
    // a grants map with BOTH `is_guest` values on the same resource.
    await step(docAddGuest.id, {
      doc_id: d2,
      subject_kind: "user",
      subject_id: GUEST_USER,
      role: "view",
    });

    // ── Spaces (ADR 0040 Step 8 slice 2) — the first `space.create` /
    //    `space.update` emitters. The walk's caller is the workspace
    //    OWNER: `space.create` sits on `workspace:admin`, and
    //    `space.update` reaches the team space via the admin backstop.
    const s1 = readIdField(
      await step(spaceCreate.id, { name: "Walk Space", space_type: "closed" }),
      "space_id",
    );
    // Patch two fields at once; replay applies the patch's post-state
    // values (the reducer merges, never re-derives).
    await step(spaceUpdate.id, {
      space_id: s1,
      name: "Walk Space v2",
      space_type: "open",
    });
    // Member family (slice 2c) on s1: add → promote → remove. SECOND_USER
    // still holds live workspace membership here (the subject-standing
    // rule); the remove must land BEFORE the archive below — archive
    // refuses on a populated roster.
    await step(spaceMemberAdd.id, { space_id: s1, user_id: SECOND_USER, role: "view" });
    await step(spaceMemberUpdateRole.id, { space_id: s1, user_id: SECOND_USER, role: "edit" });
    await step(spaceMemberRemove.id, { space_id: s1, user_id: SECOND_USER });
    // A SECOND space whose roster row SURVIVES the walk — including past
    // its subject's workspace.member_remove below (space membership rows
    // persist through the workspace-level soft-delete exactly like
    // grants; the L1 gate already cuts a removed member's access) — so
    // the final projection compares a NON-EMPTY space_members map.
    const s2 = readIdField(
      await step(spaceCreate.id, { name: "Walk Space Two", space_type: "closed" }),
      "space_id",
    );
    await step(spaceMemberAdd.id, { space_id: s2, user_id: SECOND_USER, role: "comment" });
    // Archive → restore round-trip (slice 2b): s1's roster was emptied
    // above, so the refusal counts pass; the restore authority is the
    // admin backstop on the dead row. Replay must track deleted_at
    // through BOTH flips (handler clock on archive, null on restore —
    // state-as-of-delete rides through).
    await step(spaceArchive.id, { space_id: s1 });
    await step(spaceRestore.id, { space_id: s1 });

    // ── Space-collection family (ADR 0040 space-collection slice 1) —
    //    the first space-bound collections minted THROUGH dispatch, and
    //    the first walk-reachable cross-boundary `doc.move` (closing
    //    the Step-7 deferral noted at the same-bucket move above). c3
    //    roots in s1 (open after the update step — the owner rides the
    //    open-space baseline); c4 INHERITS s1 from c3 (derivation, not
    //    input), and serving as the crossing DESTINATION pins the
    //    denormalized inheritance through replay end-to-end (Codex
    //    space-collection review pin).
    const c3 = CollectionId(
      readIdField(
        await step(collectionCreate.id, { title: "Space Root", space_id: s1 }),
        "collection_id",
      ),
    );
    const c4 = CollectionId(
      readIdField(
        await step(collectionCreate.id, { title: "Space Child", parent_id: c3 }),
        "collection_id",
      ),
    );
    // The crossing needs a grant to shed: d1's earlier edges were
    // revoked/removed above, so re-grant SECOND_USER, then
    // `adopt_baseline` hard-drops it with the preimage riding the
    // effect — replay must apply the drop. The return crossing
    // (space → legacy) under `keep_grants` records the transition
    // with ZERO grant writes.
    await step(permissionGrant.id, {
      resource_kind: "doc",
      resource_id: d1,
      subject_kind: "user",
      subject_id: SECOND_USER,
      role: "view",
    });
    await step(docMove.id, { doc_id: d1, new_collection_id: c4, acl_policy: "adopt_baseline" });
    await step(docMove.id, { doc_id: d1, new_collection_id: c1, acl_policy: "keep_grants" });
    // Same-bucket space re-parent (the collection.move regime's ALLOW
    // arm): c4 moves from c3 to a fresh sibling root in the SAME
    // space — binding rides unchanged through the effect and replay.
    const c5 = CollectionId(
      readIdField(
        await step(collectionCreate.id, { title: "Space Root Two", space_id: s1 }),
        "collection_id",
      ),
    );
    await step(collectionMove.id, {
      collection_id: c4,
      destination: { kind: "collection", collection_id: c5 },
    });
    // Collection-level CROSSING both ways (ADR 0040 crossing slice): c1
    // (legacy, holding d1) crosses into s1's root under adopt_baseline —
    // the re-granted edge on d1 hard-drops with its preimage riding the
    // ONE collection.move effect (replay must apply the drop AND the
    // rebind); the return crossing to the legacy root under keep_grants
    // records the transition with ZERO grant writes.
    await step(permissionGrant.id, {
      resource_kind: "doc",
      resource_id: d1,
      subject_kind: "user",
      subject_id: SECOND_USER,
      role: "view",
    });
    await step(collectionMove.id, {
      collection_id: c1,
      destination: { kind: "space_root", space_id: s1 },
      acl_policy: "adopt_baseline",
    });
    await step(collectionMove.id, {
      collection_id: c1,
      destination: { kind: "legacy_root" },
      acl_policy: "keep_grants",
    });

    await step(workspaceMemberRemove.id, { user_id: SECOND_USER });

    // ── Deferred-kind guard + coverage. Every effect a shipped capability
    //    actually emitted must be classified non-`deferred`; and the sequence
    //    must have exercised every state-class effect it intends to.
    const emittedKinds = new Set<AuditEffect["kind"]>();
    for (const input of captured) {
      if (input.record.outcome === "allow") {
        const kind = input.record.effect.kind;
        emittedKinds.add(kind);
        expect(REPLAY_CLASS[kind]).not.toBe("deferred");
      }
    }

    const EXPECTED_STATE_KINDS: readonly AuditEffect["kind"][] = [
      "workspace.update",
      "member.add",
      "member.update_role",
      "member.remove",
      "collection.create",
      "collection.update",
      "collection.move",
      "collection.soft_delete",
      "collection.restore",
      "doc.create",
      "doc.rename",
      "doc.move",
      "doc.publish",
      "doc.unpublish",
      "doc.soft_delete",
      "doc.restore",
      "acl.grant",
      "acl.revoke",
      "space.create",
      "space.update",
      "space.archive",
      "space.restore",
      "space.member_add",
      "space.member_update_role",
      "space.member_remove",
    ];
    for (const kind of EXPECTED_STATE_KINDS) {
      expect(emittedKinds.has(kind)).toBe(true);
      expect(REPLAY_CLASS[kind]).toBe("state");
    }
  });
});
