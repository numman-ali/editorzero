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
  type AuditEffect,
  type AuditWriteInput,
  type AuditWriter,
  type CollectionState,
  type DocState,
  type MemberState,
  memberKey,
  type PersistentWorkspaceState,
  REPLAY_CLASS,
  type ReplayRow,
  replay,
  type WorkspaceState,
} from "@editorzero/audit";
import {
  collectionCreate,
  collectionDelete,
  collectionMove,
  collectionRestore,
  collectionUpdate,
  createRegistry,
  docCreate,
  docDelete,
  docMove,
  docPublish,
  docRename,
  docRestore,
  docUnpublish,
  registerCapability,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { CapabilityContextExtras } from "../src/index";
import { createDispatcher, scopeOnlyGate } from "../src/index";

// ── Fixtures ───────────────────────────────────────────────────────────────

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const OWNER = UserId("018f0000-0000-7000-8000-000000000002");
const SECOND_USER = UserId("018f0000-0000-7000-8000-000000000003");

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

/**
 * Project the live DB into the same `PersistentWorkspaceState` the reducer
 * reconstructs — the right-hand side of the invariant-3a equality. Scoped to
 * the one workspace under test. Deliberately selects ONLY the projected
 * columns: `created_at` / `updated_at` / `diagnostic_salt` / `visibility_
 * version` are excluded by construction (see `@editorzero/audit` state.ts —
 * they are not audit-reconstructable), and `settings` is parsed to the object
 * form the reducer holds.
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
      "visibility",
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
      visibility: r.visibility,
      created_by: r.created_by,
      deleted_at: r.deleted_at,
    };
  }

  return { workspaces, members, collections, docs };
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
      registerCapability(docCreate),
      registerCapability(docRename),
      registerCapability(docMove),
      registerCapability(docPublish),
      registerCapability(docUnpublish),
      registerCapability(docDelete),
      registerCapability(docRestore),
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
    await step(collectionMove.id, { collection_id: c2, new_parent_id: null });

    const d1 = DocId(readIdField(await step(docCreate.id, { title: "Doc One" }), "doc_id"));
    const d2 = DocId(
      readIdField(await step(docCreate.id, { title: "Doc Two", collection_id: c1 }), "doc_id"),
    );
    await step(docRename.id, { doc_id: d1, title: "Doc One Renamed" });
    await step(docMove.id, { doc_id: d1, new_collection_id: c1 });
    await step(docPublish.id, { doc_id: d1 });
    await step(docUnpublish.id, { doc_id: d1 });
    await step(docDelete.id, { doc_id: d2 });
    await step(docRestore.id, { doc_id: d2 });

    await step(collectionDelete.id, { collection_id: c2 });
    await step(collectionRestore.id, { collection_id: c2 });

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
    ];
    for (const kind of EXPECTED_STATE_KINDS) {
      expect(emittedKinds.has(kind)).toBe(true);
      expect(REPLAY_CLASS[kind]).toBe("state");
    }
  });
});
