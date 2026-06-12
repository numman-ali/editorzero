# ADR 0042 — Trash listing: browse by authority; restorability stays with restore

**Status:** Proposed (draft 2026-06-12; cross-model Codex review folded same day — see Review trail; awaiting @numman)
**Date:** 2026-06-12
**Deciders:** @numman, Claude Fable 5 (cross-model Codex review pre-acceptance)

## Context

Invariant 6 says soft-deletes are recoverable via a first-class capability, and the three
restore capabilities exist (`doc.restore`, `collection.restore`, `space.restore` — API/CLI/MCP).
But **nothing can enumerate trash**: every read path hard-filters `deleted_at IS NULL`
(`doc.list`, `doc.get`, `collection.list`, `space.list`, `space.get`, `permission.list`), and
ADR 0040's read posture pins that deliberately — *"trash browse/restore discovery is a future
trash-family capability, never a widening of the live read."* The only discovery paths today are
forensic (`audit.list` filtered by `capability_id=doc.delete`, which is `workspace:admin`-floored
and see-all-by-design) or clairvoyant (already knowing the trashed id).

The gap was surfaced twice by Web UI parity cells (`doc.delete`, then `space.archive`) and now
blocks four cells outright: the Trash screen itself plus the `ui` columns of all three restore
capabilities — the largest cluster in the `UI_PENDING` ledger that isn't waiting on identity
resolution. It equally blocks CLI/MCP trash browsing (`ez trash list`); agents that trash a doc
today cannot find it again without replaying their own audit trail.

This is a design problem, not a flag: trash visibility must answer *who sees what* in a model
where the three kinds carry three different authority shapes — docs have a placement ceiling
(ADR 0040 Step 6), collections deliberately carry no ACL (B1), and trashed spaces are reachable
only through the one sanctioned dead-row ladder (`canRestoreSpace`). The Step-8 verb-asymmetric
trash postures (grant refuses trash, revoke/remove_guest work on trashed docs, `permission.list`
refuses trash) are the precedent vocabulary.

## Decision

### 1. One capability: `trash.list` — a new `trash` domain

A single read capability returns the workspace's trash as **one stream of discriminated rows**
(`kind: "doc" | "collection" | "space"`), newest-deleted first, with an optional `kind` filter.

- One screen, one round-trip, one cursor — the Trash surface is one place, not three.
- The heterogeneous-stream precedent is `audit.list` (one capability over many subject kinds);
  the per-kind alternative (three `*.list_trashed` capabilities) triples the parity surface,
  the cursor logic, and the client merge for zero authority benefit — the per-kind authority
  rules compose inside one handler exactly as well.
- An `include_deleted` input on the live lists is **rejected**, re-affirming ADR 0040: a live
  list's authority rule and a trash list's authority rule differ per kind (below), so one wire
  shape would smuggle two visibility regimes through one capability id — separate capability,
  separate audit identity, separate rate posture.
- Capability vocabulary wins the naming: `trash.list` gives `ez trash list` (CLI) and a
  `trash.list` MCP tool — agent-facing nouns that read as the OS-trash concept. The trunk
  mounts a new reserved prefix **`/trash`** (`RESERVED_API_PREFIXES` + its contract-test gate,
  dev proxy, SPA fallback, SW denylist all move in lockstep by construction). The client Trash
  screen therefore takes a non-colliding route (`/bin` or `/trashed`, decided at the cell — the
  `/audit`-vs-`/audits` precedent: the API prefix is the public contract, the SPA path is the
  cheap side).

### 2. Visibility: browse by authority — structural restorability is NOT projected

**Scopes gate verbs; rows gate visibility** (the Step-6/8 asymmetry, unchanged). `trash.list`
takes **`doc:read`** — the scope of the lists it shadows: doc and collection rows carry titles,
and their live lists (`doc.list`, `collection.list`) are `doc:read`-floored, so any lower floor
(`workspace:read`) would let a scope-limited agent read trashed titles the live tree refuses it —
the 0040 "never a widening" rule applied to scopes, not just rows. The cost is accepted and
recorded: browsing *space* trash also demands `doc:read` even though live `space.list` floors at
`workspace:read` — narrower-than-live is always safe, and a space-lifecycle-only agent wanting
trash browse without any doc-read standing is hypothetical until proven otherwise. Per kind, the
row filter is the same predicate the corresponding *acting* capability would evaluate:

| kind | row visible iff | which is exactly |
|---|---|---|
| `doc` | `canRead` on the **stored placement** (trashed parent collections still bind; trashed/dangling space ⇒ anomaly ⇒ invisible) | `doc.restore`'s authority gate, in `doc.list`'s FILTER posture |
| `collection` | the live `collection.list` posture — **lockstep**, today unfiltered beyond scope | `collection.restore`'s authority (scope-only; collections carry no ACL — B1) |
| `space` | `canRestoreSpace` — the dead-row ladder (personal → `owner_user_id`; team → non-guest owner grant ∨ admin backstop; **no membership rung**) | `space.restore`'s authority gate |

Consequences this buys, stated so they are deliberate:

- **Visible is not restorable — deliberately.** These predicates are pure *authority*; the
  structural restore preconditions (parent/space liveness, sibling slug, personal twin, depth
  cap) are **not** projected into visibility. They stay owned by the restore capabilities alone
  and surface as their typed refusals (`parent_deleted`, slug collision, …) when a visible row's
  restore is attempted. Projecting them would re-state each precondition outside the capability
  that owns it (the same drift class as the rejected restorability flags below), would make rows
  *vanish* from trash the moment a parent is trashed (inventory dishonesty — fifty trashed docs
  collapsing to one collection row), and would still not buy a true "restorable set" (slug and
  twin collisions depend on the volatile live namespace and refuse at attempt time regardless).
  A doc under a trashed collection in a live space is therefore **visible-but-refusing** until
  the collection is restored — and that collection is a row in the *same list*, so the
  `parent_deleted` arm's remediation is discoverable in place.
- **The anomaly horizon is the one visibility cliff — an authority fact, not a projected
  precondition.** A trashed doc whose stored placement crosses an archived/dangling space is
  invisible because `canRead` itself fails closed on anomaly — for admins too. Trashed
  collections under that space stay visible (scope-only posture) but refuse `parent_deleted`
  until a ladder principal restores the space; for non-ladder principals that refusal names a
  container they cannot see. Austere, and accepted: archive is an *emptying ritual* (it refuses
  on live descendants and on any roster row), so every doc under the space was already trashed
  before the archive could pass — nothing live ever hides, and the cliff only moves when a
  deliberate admin-tier act moves it.
- **Trashed-space rows are ladder-only, not reach-wide.** A surviving non-owner space grant
  (edit/view rides through archive, H1) does **not** reveal the trash row: there is no verb such
  a holder could exercise on a dead space (restore needs the ladder; there is no trashed-space
  read), and 0040 frames this capability as *restore discovery*, not a memorial. Corollary,
  recorded: a non-ladder principal can lose trash *discoverability* mid-stream — their trashed
  doc was browseable while the space lived, then an ancestor archive pulls it under the anomaly
  horizon. "Where did my space go" / "where did my doc go" is a notification/activity concern,
  never a listing widening.
- **Collections stay lockstep with their live list.** Today that means any principal clearing
  the `doc:read` floor sees all trashed collection titles — identical reveal to the live tree,
  so trash adds zero new exposure. The recorded Step-7/8 obligation to ceiling-gate
  `collection.*` reads applies to this capability *in the same future slice*, by reference here.
- **No `workspace:admin` floor.** Admin-only trash would orphan the mainstream case (a member
  recovering their own doc without filing a ticket). Admins get their wider view through the
  forensic plane (`audit.list`, see-all-by-design), which already exists and stays the only
  see-all surface.
- **Scope floor vs restore scope can diverge, deliberately.** A `doc:read` agent may *see* a
  trash row it cannot *restore* (restore demands `doc:delete` / `space:manage`).
  Browse-without-restore is honest read-only standing, the same way `doc.list` shows docs a
  viewer cannot edit; surfaces render the refusal (or elide the button) per scope.

### 3. Wire shape

Input (one zod schema in `@editorzero/schemas`, ADR 0034 SSOT — `z.coerce` so the same module
validates HTTP query strings and CLI/MCP numbers):

```
limit:              int 1..200, default 50
before_deleted_at:  epoch-ms, optional ┐ both-or-neither refine
before_id:          uuid, optional     ┘ (the audit.list cursor contract)
kind:               "doc" | "collection" | "space", optional
```

Output: `{ items: TrashRow[], next_cursor: { before_deleted_at, before_id } | null }` where
`TrashRow` is the discriminated union of **stored facts only**:

```
{ kind: "doc",        id, title, slug, collection_id, deleted_at }
{ kind: "collection", id, title, slug, parent_id, space_id, deleted_at }
{ kind: "space",      id, name,  slug, space_type, deleted_at }
```

- **Order:** `(deleted_at DESC, id DESC)` — newest trash first; id tiebreak makes the cursor
  total. **The cursor is defined over the post-authority *visible* stream, not the raw trashed
  stream.** `audit.list`'s peek-limit cannot be taken verbatim: there, every SQL row is visible;
  here, doc/space visibility is resolver-evaluated after the fetch, so a raw `limit + 1` fetch
  then in-memory filter would return empty/short pages with a wrong `next_cursor` whenever an
  invisible prefix sits newest (two hundred docs trashed inside an archived space above one
  visible row). The handler scans raw candidates in cursor order until it holds `limit + 1`
  **visible** rows or exhausts the table; `next_cursor` echoes the last *returned* row's
  `(deleted_at, id)` — a position in the total order, so resumption rescans nothing already
  served. The property suite pins the invisible-prefix canary: many newer invisible rows above
  one older visible row ⇒ page 1 returns the visible row with a correct cursor. Worst-case scan
  cost is bounded by total trash size (unbounded-by-construction until the sweeper exists) —
  accepted for a housekeeping read. Unlike the live lists (unpaginated by design), trash
  paginates **from birth**.
- **Lean rows, client joins.** Placement labels resolve client-side from caches the shell
  already warms (`collection.list`, `space.list`) or from sibling rows in this very list (a
  trashed parent is itself a trash row). No denormalized label fields to drift.
- **No derived restorability flags** (`restorable`, `parent_trashed`, …). Each would re-state a
  restore precondition (sibling-slug, parent-liveness, personal-twin, depth-cap) outside the
  capability that owns it — a drift surface; the restore capabilities stay sole authority and
  their typed refusals (409/400 arms) are the UI's honest signal, per the established cell
  recipe. Revisit only if real usage shows blind-attempt loops.
- **No `deleted_by`.** The tables don't store it; *who* trashed a thing is the audit plane's
  answer (`audit.list` subject filter → the detail screen), already built. Adding columns for a
  listing nicety is schema churn without an invariant behind it.

### 4. Dispatcher posture

Read lane (no `ctx.transact`, no mutation, not a `METADATA_ONLY_CAPABILITIES` member — that set
is for mutations). Rate: the read tier (600), `space.list`'s row. Audit: collapsible read,
`audit.access_log`, constant bucket on `list` (the `space.list` posture). The resolver loads
once per call (`loadDocReadResolver`) and serves all three predicates — its collections preload
already includes trashed rows precisely so stored placements evaluate (the `doc.restore`
precedent); `canRestoreSpace` is already exported as the intent-named dead-row ladder. **No new
authority vocabulary is minted by this ADR.**

### 5. Surfaces + the unblocked cells

`surfaces: ["api", "cli", "mcp"]` at birth with contract tests; `"ui"` flips when the Trash
screen cell lands (`UI_PENDING` +1 now, then −4: the screen proves `trash.list` and hosts the
restore buttons that prove `doc.restore`, `collection.restore`, `space.restore` — per-row
actions surfacing each capability's typed refusal arms).

### Non-goals (this ADR)

- **Purge / sweeper / retention enforcement.** `trash_retention_days` is stored but inert; the
  reaper, `doc.purge`, `workspace.purge`, and the reserved `purge` queue stay ADR 0017 future
  work. Corollary: the Trash screen shows `deleted_at` ("trashed 3 days ago") and **must not**
  show a purge countdown until something actually purges — a countdown nothing enforces is a
  lie in the UI.
- **Empty-trash / bulk restore verbs.** Per-row restore only; a `trash.empty` (or purge-all)
  is a separate capability with its own inverse story when the purge family lands.
- **Subject-oriented sweeps** ("everything I deleted") — the `permission.list` precedent:
  resource/stream-oriented now; a subject pivot is a different capability with a different
  authority rule.
- **Workspace-level trash** (`workspace.delete` is itself still deferred).

## Consequences

- Trash becomes a first-class, parity-complete read: agents and humans recover their own work
  without admin escalation, on every surface (invariant 4 row; invariant 6 finally has a
  discovery path, not just an inverse verb).
- The browse predicates reuse the acting authorities verbatim — no second vocabulary to drift
  from the resolver — and the visibility table above **is** the property-test oracle
  (`trash.list ∩ kind=doc` ≡ trashed docs where `canRead(stored placement)`, etc., over the
  visible-stream cursor). Restore refusals are deliberately *outside* the oracle: structural
  restorability belongs to the restore capabilities' own suites.
- Four `UI_PENDING` cells unblock behind one capability; the remaining ledger (member /
  permission / guest cells) is then blocked solely on identity resolution.
- A tenth reserved prefix (`/trash`) joins the SSOT; the SPA's natural `/trash` route is
  forfeited (minor, the `/audit` precedent).
- The collection-visibility lockstep ties this capability to the future `collection.*`
  ceiling-gating slice — recorded here so that slice cannot narrow the live tree and forget
  the trash view.

## Review trail

**Cross-model review (Codex, 2026-06-12, pre-acceptance).** Two MUST-FIXes + one SHOULD-FIX,
all applied; four explicit keeps.

- **MUST-FIX 1 — frame contradiction.** The draft's prose claimed restorable-set semantics
  ("the collection's row appears after the space is restored") while the visibility table was
  already pure authority: a trashed collection under an archived space is visible (scope-only)
  the whole time, restore-refusing; a doc under a trashed parent collection in a live space is
  likewise visible-but-refusing. Codex offered both frames with conditions; **browse semantics
  chosen** (title rewritten, the false remediation-order claim deleted, visible-but-refusing
  made explicit). Rationale for not taking his lean: strict restorable-set visibility would
  re-state parent-liveness *outside* the restore capabilities — the same drift class this ADR
  rejects for restorability flags — and its set would still refuse on slug/twin/depth at attempt
  time, so the crisp name was unearnable. The table needing zero edits was the tell that
  authority-shaped predicates are the natural set.
- **MUST-FIX 2 — cursor over the visible stream.** Raw-stream peek-limit plus in-memory
  filtering returns empty/short pages with a wrong `next_cursor` under an invisible-newest
  prefix. The cursor contract is now defined over the post-authority visible stream
  (scan-until-filled), with the invisible-prefix canary pinned for the property suite.
- **SHOULD-FIX** — stale `workspace:read` wording in the collection-lockstep consequence
  (predating the `doc:read` floor flip) corrected.
- **Keeps:** ladder-only trashed-space visibility ("a future restoration fact, not a current
  visibility right"); the unified `doc:read` floor (narrower-than-live for spaces beats
  splitting per-kind for a hypothetical actor); `trash.list` + `/trash` naming ("losing the SPA
  `/trash` route is cheaper than making agents say `workspace.list_trash` forever"); the
  stranded-owner austerity — sound because archive's emptying ritual means the doc was trashed
  before the space died — with the discoverability-loss corollary now documented.

## Revisit triggers

- The purge/reaper slice lands → add retention-horizon presentation (now honest) and decide
  `trash.empty`.
- Blind restore-attempt loops show up in real usage → reconsider derived restorability hints
  (as resolver-owned projections, never restated preconditions).
- The `collection.*` ceiling-gating slice lands → apply the same gate here (lockstep
  obligation above).
- A "where did my space go" product need appears for non-ladder principals → notification
  lane, not listing widening.
