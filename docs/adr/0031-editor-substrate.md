# ADR 0031 — Editor substrate: bootstrap on BlockNote, eject to Tiptap v3 + an owned thin block layer (clean-start)

**Status:** Accepted (2026-05-30; supersedes ADR 0004)
**Date:** 2026-05-29
**Deciders:** @numman (determination delegated to Claude Opus 4.8; review `wf_b3e0aac1-bff`)

## Context

ADR 0004 chose **BlockNote** and made an explicit bet (line 33): *"FOSDEM 2026's Yjs 14 track-changes work lands upstream through BlockNote — we inherit versioning / track-changes primitives without owning them."* Nomi reopened the editor decision: BlockNote is *"not easily replaceable atm"* (embedded cost is real), but he is open to raw Tiptap + owned components *"if better for control / scalability / agent-DX / customisation,"* and he confirmed **track-changes / version-history is near-term core** (ADR 0032).

The review verified the facts that decide this:

- **BlockNote *is* Tiptap v3 + ProseMirror underneath** (`@tiptap/core@3.x` is already a transitive dep). Ejecting to Tiptap is not an ecosystem change — it is removing the block-abstraction wrapper while keeping the same ProseMirror/Yjs engine.
- **The BlockNote bet ADR 0004 rests on is unshipped.** BlockNote track-changes is an upstream Yjs-14 bet (Kevin Jahns, FOSDEM 2026), not a shipped primitive. We cannot "inherit without owning" something that does not yet exist — and ADR 0032 decides we build track-changes ourselves regardless, which wants **schema sovereignty** the block wrapper does not give.
- **Coupling is localized.** BlockNote touches `packages/sync` and `packages/blocks`; `hocuspocus.ts` is raw-Yjs and survives a substrate swap untouched. The headless mutation path (ADR 0018: `editor.mount` + DOM shim) is a server-dispatcher concern, substrate-shaped but not substrate-locked.
- **Stored `doc_updates` encode BlockNote's ProseMirror schema.** y-prosemirror reconstructs PM nodes by **looking up each stored `nodeName` in the active schema**; unknown names are silently dropped. An owned schema with **our own node names cannot read old BlockNote fragments** — so a swap is a **clean-start, not a migration**. Pre-1.0 with little/no production data makes clean-start acceptable; the review's "migration ≈ zero / matched schema reads old bytes" claim was a red-team-confirmed **falsehood** and is rejected.
- **Licensing / churn signals point the same way.** BlockNote's `@blocknote/xl-*` (AI, export, multi-column) are **GPL-3.0** — AGPL-compatible only one-way and irreversibly copyleft (ADR 0004 already documents this). BlockNote 0.51 rewrote its Markdown layer and dropped ~80 remark/mdast deps; `blocksToFullHTML` crashes headless on React-rendered/image blocks (open #1049/#720). We already route the published-doc render *around* `blocksToFullHTML` (ADR 0027). The dependency is churny at exactly the seams we care about.

## Options considered

- **A. Stay on BlockNote indefinitely** — REJECTED: forfeits schema sovereignty that ADR 0032 (own track-changes) needs; keeps us exposed to GPL-3.0 `xl-*` temptation and upstream churn at the Markdown/HTML seams; the inherited-track-changes premise is unshipped.
- **B1. Eject to Tiptap v3, reuse BlockNote's *node names*** so old fragments read back — REJECTED: keeping their node-name vocabulary to preserve readback re-couples us to their schema (the thing we're ejecting for) and the readback "win" is moot pre-1.0 anyway.
- **B2. Eject to Tiptap v3 + an owned thin block layer with our own node names (clean-start)** — CHOSEN.
- **C. Rip out BlockNote now, before any UI exists** — REJECTED on sequencing: BlockNote works *today* and unblocks the SPA bootstrap; ejecting first would stall the whole Web UI behind editor R&D.

## Decision

**Bootstrap the Web UI editor on BlockNote (it works today), then eject to Tiptap v3 + an owned thin block layer (option B2) as a near-term slice fused with the track-changes/version-history work (ADR 0032).**

- **Phase 1 — bootstrap on BlockNote.** Stand up the SPA editor route (ADR 0027/0028) on the current BlockNote integration. This unblocks every other Web UI slice (routing, auth, RPC, reader path) without waiting on editor R&D.
- **Phase 2 — eject to Tiptap v3 + owned blocks, clean-start, fused with ADR 0032.** Replace the BlockNote wrapper with a thin owned block layer over `@tiptap/core@3` + ProseMirror (same engine, our schema, our node names). This is a **clean-start**: the new schema does not read old BlockNote fragments, which is fine pre-1.0. Owning the schema is the precondition for owning track-changes (ADR 0032), so the two land together.
- **Clean-start constraint, made explicit (Codex finding).** Clean-start is correct **only while there is no durable editor data to preserve**. Two guard rails hold that: (a) **no durable dogfood/production editor content is created before the Phase-2 owned schema lands**, or (b) if it is, a **Markdown / block-JSON export→import bridge** carries it across the schema change. The bridge is cheap to promise — invariant 1 (per-block Markdown fidelity) and the neutral block-JSON projection (ADR 0027) already give a substrate-independent serialization — so even if content accumulates, the migration degrades to a content round-trip through Markdown / block-JSON, never a lossy y-prosemirror fragment migration.
- **The render path is already substrate-independent.** The published-doc HTML projection (ADR 0027) and Markdown fidelity (ADR 0013, invariant 1) run off editorzero's own block-JSON `BlockTypeSpec` kernel, not off BlockNote internals — so they survive the swap verbatim. `hocuspocus.ts` (raw-Yjs) survives untouched.

## Consequences

- **Reverses ADR 0004's central bet and supersedes it.** We no longer plan to inherit versioning/track-changes from BlockNote; we own them (ADR 0032). ADR 0004 moves to Superseded with a pointer here.
- **Two editor integrations get built, deliberately.** BlockNote first, then the owned Tiptap layer. The first is throwaway scaffolding by design — accepted, because it buys parallel progress on the entire rest of the Web UI while the editor R&D happens behind it.
- **Schema sovereignty is the prize.** Our own node names + marks mean track-changes, suggestions, and tracked agent edits (ADR 0032) are first-class in the schema rather than bolted onto a vendor's. Control / scalability / agent-DX / customisation — Nomi's four criteria — all improve at the cost of owning the block-UI chrome (ADR 0004 already scoped this at ~2–4 eng-weeks for the chrome).
- **Clean-start must be stated as a product fact, not hidden.** Any pre-existing BlockNote-authored docs do not survive the Phase-2 swap. Pre-1.0 this is acceptable; it must be called out in the slice's runbook and the migration note, and the "fragment readback" test becomes a **new-schema round-trip** test (author → encode → decode under the owned schema → identical), not a cross-schema read.
- **`xl-*` GPL-3.0 exposure ends.** Owned export/AI/multi-column components are authored under AGPL with no GPL-3.0 one-way dependency to manage.
- **Invariants hold across the swap.** Per-block Markdown fidelity (1), CRDT convergence (2), one-audit-entry-per-mutation (3) are properties of the block-JSON kernel + dispatcher + raw-Yjs layer, none of which the substrate swap touches; property tests (Phase 3+) gate the new schema the same as the old.

## Revisit triggers

- **BlockNote ships free, self-hostable, Yjs-14 track-changes *before* Phase 2 starts** and it fits our capability model: re-weigh Phase 2 — though schema sovereignty for tracked *agent* edits (ADR 0032) is an independent reason to own the layer.
- **The owned Tiptap block layer balloons past the ~2–4 eng-week chrome estimate**: re-scope — possibly keep BlockNote longer and build track-changes against its schema as an interim, accepting the re-coupling.
- **Production data accumulates before Phase 2** (clean-start stops being free): trigger the Markdown / block-JSON export→import bridge (Decision guard rail b) rather than a lossy y-prosemirror fragment migration; cost the bridge explicitly before proceeding.

## Cross-references

- **Supersedes** ADR 0004 (rich-text editor). **Fused with** ADR 0032 (version-history + track-changes — the reason for schema sovereignty).
- **Preserves** ADR 0013 (Markdown fidelity, invariant 1), ADR 0018 (headless write path), the raw-Yjs `hocuspocus.ts`.
- **Independent of** ADR 0027 topology (editor route is `ssr: false` either way); the ADR 0027 reader render deliberately avoids `blocksToFullHTML`.
