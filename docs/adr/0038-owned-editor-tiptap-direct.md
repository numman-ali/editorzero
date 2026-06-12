# ADR 0038 — Owned editor: adopt Tiptap v3 directly + DOM-free server write path

**Status:** Accepted (new, 2026-05-31; supersedes ADR 0031, which superseded ADR 0004)
**Date:** 2026-05-31
**Deciders:** @numman (custom UI; the BlockNote bootstrap is no longer wanted); Claude Opus 4.8 (substrate + write-path determination, delegated per AGENTS.md)

## Context

ADR 0031 chose a **two-phase** plan: *Phase 1* bootstrap the editor on BlockNote (it worked today), *Phase 2* eject to an owned thin block layer over Tiptap v3 + ProseMirror (clean-start, for the schema sovereignty that track-changes — ADR 0032 — needs). Two things changed since, which collapse the two phases into one:

1. **The design system is now Base UI, not Mantine (ADR 0037).** A BlockNote Phase-1 bootstrap would pull in `@blocknote/mantine` + Mantine's CSS purely as throwaway scaffolding that *fights* the token cascade ADR 0037 depends on.
2. **The SPA scaffold (ADR 0035) has no working BlockNote editor route yet** — only the scaffold. There is no Phase-1 investment to protect, so the bootstrap now buys parallelism we already have and costs a throwaway integration + a later clean-start migration.

A research Workflow (`wf_734a602e-3d6`, Verdict 1) adversarially verified the load-bearing editor facts against the live npm registry on 2026-05-31 — and **corrected two of this ADR's draft claims** (below), which is exactly why it ran before the ADR locked.

## Options considered

- **A. Keep ADR 0031's two-phase (BlockNote bootstrap → eject).** REJECTED: the bootstrap buys nothing now (no editor route shipped; Base UI, not Mantine) and costs a throwaway Mantine integration plus a clean-start migration later.
- **B. Adopt Tiptap v3 + an owned thin block layer DIRECTLY (skip the BlockNote phase).** CHOSEN. Same engine BlockNote sits on, our schema from day one, no throwaway phase.
- **C. Stay on BlockNote indefinitely.** REJECTED (as in ADR 0031): forfeits the schema sovereignty ADR 0032 needs; keeps GPL-3.0 `@blocknote/xl-*` exposure; churny at the Markdown/HTML seams.

## Decision

**Build the editor as an owned thin block layer over Tiptap v3 + ProseMirror, directly** (ADR 0031 option B2, minus the Phase-1 bootstrap).

- **Import discipline.** ProseMirror only via `@tiptap/pm/*` subpaths (never bare `prosemirror-*`). **All `@tiptap/*` pinned exact, in lockstep** (the rename churn in this line makes caret-pinning mandatory). **All `@hocuspocus/*` in lockstep.**
- **Collaboration** binds via `@tiptap/y-tiptap` (Tiptap's fork of `y-prosemirror`, mapping a `Y.XmlFragment` to ProseMirror state), staying on **Yjs v13**.
- **Presence:** `CollaborationCaret` (renamed from `CollaborationCursor`) carrying a custom **`principalKind` (`human` | `agent`)** attribute — the user object accepts arbitrary attributes — to render the ADR 0036 human/agent split.
- **Load-bearing pay-off — a DOM-free, JSON-in server write path** (verified end-to-end against the published dist `.d.ts` + Hocuspocus docs):
  - **Write:** `prosemirrorJSONToYDoc` / `updateYFragment` (real exports of `@tiptap/y-tiptap@3.0.4`) + `ydoc.transact` inside Hocuspocus `openDirectConnection(name, ctx).transact(fn)` (the documented WebSocket-free server mutation API).
  - **Read:** DOM-free via `@tiptap/static-renderer` + `@hocuspocus/transformer`'s `TiptapTransformer.fromYdoc`.
  - **Rule: writes are JSON-in, NEVER HTML-in.** HTML parsing needs a DOM (`generateJSON` throws *"document is not defined"* in Node); `@tiptap/html` exists only via a `zeed-dom` **virtual** DOM with documented fidelity gaps (computed-style marks like Underline) + v3.4.x import bugs (#6939/#6951). Any HTML-import feature must round-trip through JSON, not `@tiptap/html`.
  - **Consequence for ADR 0018:** this **removes the `happy-dom` shim from the production write path** — it becomes a test-environment-only concern, directly improving ADR 0018's posture.

- **Pins** (verified live npm 2026-05-31, `wf_734a602e-3d6` Verdict 1; corrections folded in):

  | Package | Pin | Note |
  |---|---|---|
  | `@tiptap/core`, `@tiptap/pm`, `@tiptap/react`, `@tiptap/suggestion`, `@tiptap/extension-collaboration-caret`, `@tiptap/static-renderer` | `3.24.0` | Exact, **lockstep** (no `^`). `@tiptap/pm` is the only ProseMirror entry point (re-exports `./view ./model ./state ./transform ./changeset …`). Menus live at the `@tiptap/react/menus` subpath; `@tiptap/suggestion` is the slash-command / `@`-mention primitive; `CollaborationCaret` is renamed from the v2-frozen `@tiptap/extension-collaboration-cursor` (2.26.2). |
  | `@tiptap/y-tiptap` | `3.0.4` | Tiptap's fork of `y-prosemirror`. `peerDeps`: `yjs ^13.5.38` + `y-protocols ^1.0.1`. Exports the DOM-free write helpers `prosemirrorJSONToYDoc` / `prosemirrorToYDoc` / `updateYFragment`. |
  | `yjs` | `^13` (catalog) | **STAY on v13.** **CORRECTED:** avoid **`@y/prosemirror`** (the `@y/y` / Yjs-v14 ecosystem). Upstream `y-prosemirror` has **NO 2.x release** (latest `1.3.7`, peer-deps `yjs ^13.5.38`) — do **not** cite a non-existent `y-prosemirror@2.0.0`; the v14 work ships under the *different* package name `@y/prosemirror`. |
  | `prosemirror-changeset` | via `@tiptap/pm/changeset` | The diff/decoration engine for track-changes (ADR 0032). MIT. |
  | `@hocuspocus/server`, `@hocuspocus/transformer` | **DEFERRED to the slice** | The repo pins **3.4.4** (`packages/sync/package.json`); npm latest is **4.1.0** (2026-05-20) — a **MAJOR** jump. The slice must pick the version and re-verify hook semantics (`onStoreDocument` non-concurrent per doc; `beforeSync` no longer awaited — AGENTS.md *Gotchas*) + reconnect-auth (#566/#752) against whatever is actually deployed. Keep `@hocuspocus/*` in lockstep. |

## Consequences

These risks are **load-bearing and must be covered by write-path tests** (none is a blocker):

- **Audit attribution (invariant 3 / ADR 0018).** On Hocuspocus v4, `DirectConnection.transact` does **not** propagate context into the inner Y transaction (#833) — attribution must be injected on the inner `doc.transact(fn, origin)`, not the outer `transact` ctx. Directly load-bearing for one-audit-row-per-mutation.
- **DirectConnection state-corruption window (#832):** a direct write while **no** WS clients are attached can orphan the doc for clients connecting within the debounce window, and `storeDocument` can fire twice. Relevant to ADR 0027's broadcast-after-commit gap.
- **CollaborationCaret has open v3 bugs:** crashes with tables present (#6979/#7232) and caret drift (#7213). **Exercise caret + tables in the editor smoke** before relying on it for presence.
- **Mobile / Android is owned-editor territory.** Tiptap's virtual-keyboard bug (#6571) is open with no upstream fix; ProseMirror IME `compositionend`-after-blur reorders transactions (#784); `contenteditable=false` leaf nodes break backspace and dismiss the keyboard on Android. Owning the layer turns *"we must own mobile keyboard handling"* from a liability into a clean ownership boundary (ADR 0039). Track-changes decorations during active IME composition need composition-aware guards (ADR 0032).
- **`@blocknote/xl-*` GPL-3.0 exposure is never incurred** — we never integrate BlockNote.
- **Clean-start holds (from ADR 0031), and is now free.** Owned node names cannot read old BlockNote fragments — but since *no editor content ships before this layer*, there is nothing to migrate. Guard rail: no durable editor content before the owned schema lands, else a Markdown / block-JSON export→import bridge (never a lossy y-prosemirror fragment migration).
- **One fewer integration built.** No throwaway BlockNote/Mantine bootstrap — a net simplification versus ADR 0031.

## Revisit triggers

- The owned block layer **balloons past the ~2–4 eng-week chrome estimate** (ADR 0031) once track-changes + mobile-keyboard + IME guards are included → re-scope (possibly keep BlockNote longer as an interim, accepting re-coupling).
- **Hocuspocus v4 hook semantics prove incompatible** with the write-path needs → pin the co-hosting-smoke-verified `3.4.4` and defer the v4 bump.
- BlockNote ships **free, self-hostable, Yjs-14 track-changes** that fits the capability model → re-weigh (but schema sovereignty for tracked *agent* edits, ADR 0032, is an independent reason to own the layer).

## Cross-references

- **Supersedes** ADR 0031 (drops the BlockNote Phase-1 bootstrap; carries forward its owned-Tiptap + clean-start + schema-sovereignty reasoning). Chain: 0004 → 0031 → **0038**.
- **Fused with** ADR 0032 (version-history + track-changes — the reason for schema sovereignty). **Improves** ADR 0018 (the DOM-free write path removes the `happy-dom` shim from production). **Preserves** ADR 0013 (per-block Markdown fidelity, invariant 1) and the raw-Yjs `hocuspocus.ts`.
- **Pairs with** ADR 0037 (Base UI shell; Floating-UI convergence on `@floating-ui/dom@1.7.6`) and ADR 0039 (mobile editor keyboard / safe-area ownership).
- **Research:** `wf_734a602e-3d6` Verdict 1 (Tiptap stack, live npm 2026-05-31) + the owned-editor synthesis memo.

## Amendment — 2026-06-12: server-side layer landed (Slice A of the editor slice)

The owned block layer + DOM-free write path shipped. What the decision text predicted vs. what landed:

- **Landed.** `@editorzero/blocks` (owned model / Tiptap extensions / PM mapping / op applier + diff / isomorphic hash) and the `@editorzero/sync` rewrite (`readBlocks` / `writeBlocks` / `seedBlocks`, synchronous `setDocTitle`). BlockNote and `happy-dom` are evicted from the trunk entirely — zero lockfile references, no DOM shim anywhere (the `ensureDomGlobals` hook is gone from `apps/server`'s boot). ADR 0018's "shim becomes test-only" consequence landed *stronger than predicted*: there is no shim in tests either.
- **Write path refinement.** The Decision named `prosemirrorJSONToYDoc`; the landed path is `blocksToPmDoc → Node.fromJSON(schema) + check() → updateYFragment(ydoc, fragment, node, {mapping, isOMark})`. `prosemirrorJSONToYDoc` builds a *fresh* doc — `updateYFragment` diffs in place, which is what preserves history. Verified against the 3.0.4 source and pinned by unit tests: one `ydoc.transact` per write (→ exactly one `doc_updates` row, §6.5) and equality-matched children keep their Yjs node identity.
- **Read path refinement.** No `@tiptap/static-renderer` / `@hocuspocus/transformer` needed server-side: reads are `yXmlFragmentToProseMirrorRootNode(fragment, schema) → toJSON() → pmDocToBlocks`. Those packages stay unpinned until a feature (static HTML render) actually wants them.
- **Pins installed.** `@tiptap/core` / `@tiptap/pm` / `@tiptap/react` `3.24.0` + `@tiptap/y-tiptap` `3.0.4` (exact, catalog-managed). `3.26.1` / `3.0.5` were published 2026-06-11 — inside the pnpm `minimumReleaseAge` cooldown — so the ADR-verified pair stands; bump later in lockstep. Lockfile resolves a single `prosemirror-model@1.25.4` (no dual-instance risk). `suggestion` / `collaboration-caret` / `static-renderer` install with the features that use them.
- **Hocuspocus stays `3.4.4`** (the co-hosting-smoke-verified pin; the "DEFERRED to the slice" row resolves to: keep v3). The v4 consequences in this ADR (#832/#833) are re-evaluated at bump time; the audit attribution path doesn't depend on Y-transaction origin today (the dispatcher writes audit rows under its own tx).
- **Wire-shape decision.** The block JSON shape (`{id, type, props, content, children}` + styled-text runs) is preserved from the BlockNote era, now owned. BlockNote's default-prop bag (`textColor` / `backgroundColor` / `textAlignment`) is dropped from `props` — no consumer asserted it. The BlockNote mount's "normalisation-tail" empty paragraph is gone: `doc.update` post-states contain exactly what the applier produced (the full-stack e2e asserts 3 blocks where it used to tolerate 4). `id: ""` is the unminted sentinel for browser-created blocks; the server mints on insert.
- **Op semantics SSOT.** `applyOpsToBlocks` (server applier) and `diffBlocksToOps` (browser diff) live in one module (`packages/blocks/src/ops.ts`); the law `apply(before, diff(before, after)) ≡ after` (modulo minted insert ids) is property-swept through the *real* `DocUpdateInputSchema` parse, so diff output is proven to validate against the wire contract. The `expect_prior_content_hash` precondition uses one WebCrypto SHA-256 implementation on both sides (`packages/blocks/src/hash.ts`, known-vector-pinned).

## Amendment — 2026-06-13: the browser collab slice landed (the live canvas over ADR 0043's write lane)

The Collaboration line in the Decision is now real in the SPA; landing decisions:

- **Pins.** `@hocuspocus/provider@3.4.4` (the "all `@hocuspocus/*` in lockstep" rule cashed out — the server's co-hosting-verified pin decides the client's) and `@tiptap/extension-collaboration@3.24.0` joined the catalog's exact-lockstep tiptap line. The binding is `Collaboration.configure({ fragment })` over the doc's `Y.XmlFragment` — `@tiptap/y-tiptap`'s ySync/yUndo plugins under the hood, as decided. No history-extension conflict: the owned extension set never carried one (collab mode therefore ADDS undo, Yjs-backed).
- **Wire-shared constants moved to `@editorzero/constants`.** `DOC_FRAGMENT` (the durable fragment name) and the ADR 0043 revocation-close vocabulary (`COLLAB_REVOKED_CLOSE_CODE` 4401 + `COLLAB_REVOKED_REASON`) were defined in `@editorzero/sync` — a Node-only package the browser cannot import. Both sides of the wire need them and only one may own them; they now live as import-free leaf modules in constants (the `reserved-prefixes.ts` pattern), re-exported by sync/api-server so no public surface moved.
- **Session policy is a pure reducer** (`apps/app/src/lib/collab.ts`, unit-tested): 4401 is TERMINAL — the component destroys the provider, killing its built-in backoff (ADR 0043's "re-auth, don't blind-retry"; the provider otherwise blind-reconnects forever). Per-document closes arrive with a synthesized `code: 1000` + the wire reason (3.4.4 provider mechanics), so doc-level revocation is classified by `COLLAB_REVOKED_REASON`; any other per-doc reason is the generic Hocuspocus reset (refused write / server exception) — also terminal, with a reload affordance. Post-sync transport loss PAUSES the canvas read-only while the provider reconnects (ADR 0039: offline edits would queue into an offline-write lane this product does not have).
- **The HTTP editor is the degrade lane, not dead code.** WS unreachable (first pre-sync transport close — decisive, no retry limbo), the operator's `collabReadOnly` pin (scope `readonly` at auth: WS writes would be silently nacked; `doc.update` + explicit Save still works in that posture), and pre-sync auth refusal all fall back to the ADR 0038 Slice-B editor. The `doc.update` ui cell stays honestly proven — `editor.spec.ts` blocks the WS upgrade and pins the whole Save flow on the fallback; the live lane's proof is `live-collab.spec.ts` (`doc.apply_update` ui cell: live cross-tab broadcast + audit rows + reload persistence + the 4401 re-auth notice).
- **The canvas mounts only after the first sync.** A Tiptap instance bound to a still-empty fragment normalizes the doc by inserting an empty paragraph locally, and that junk block would sync UP the moment the handshake lands — pre-sync nothing is mounted that could mutate.
- **`token: null`** — the session cookie authenticates the upgrade (ADR 0030) and the per-frame dispatch re-resolves it; the Auth frame's token field is unused server-side.
- **Presence stays deferred.** `CollaborationCaret` remains uninstalled per this ADR's own open-bug caveat (#6979/#7232 tables crash, #7213 drift) — a follow-up increment with the smoke the Consequences demand. The provider's default Awareness instance stays ENABLED (3.4.4 ping checks break without at least one awareness-bearing provider per socket; the server's write gate passes Awareness frames).
- **Known rough edge (recorded, not fixed here):** a read-only-by-permission principal gets a live canvas it can type into locally; the first delta is refused at dispatch and the gate closes the doc's feed (`doc_closed` notice). Pre-disabling the canvas needs a write-standing projection on `doc.get` — same projection-gap family as the movers' `placeable` flag (punch list).
