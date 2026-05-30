# ADR 0004 — Rich-text editor: BlockNote

**Status:** Superseded by [ADR 0031](0031-editor-substrate.md) (2026-05-30)
**Date:** 2026-04-17 (v2); superseded 2026-05-30
**Deciders:** @numman

> **Superseded by [ADR 0031](0031-editor-substrate.md) + [ADR 0032](0032-version-history-track-changes.md) (2026-05-30).** BlockNote remains the *bootstrap* editor, but the standing decision is to eject to Tiptap v3 + an owned thin block layer (clean-start) and to **build** version-history / track-changes ourselves on Yjs snapshots + `prosemirror-changeset` — reversing this ADR's bet (the FOSDEM-2026 line below) that we would *inherit* track-changes from BlockNote's upstream Yjs-14 work. Neither BlockNote nor Tiptap ships free + self-hostable track-changes, and the killer feature (tracked *agent* edits) wants schema sovereignty we don't get from a vendor's block wrapper.

## Context
ADR 0013 v1 made "Markdown AST is the source of truth" a monolithic hard invariant, which uniquely qualified Milkdown (remark-under-the-hood) as the editor. ADR 0013 v2 relaxes that: **the CRDT (Yjs) is the source of truth; each block type declares its own Markdown fidelity contract.** Under the relaxed constraint, the editor choice is re-opened.

Additional signals from the April 2026 refresh:
- **Milkdown** is effectively solo-maintained by Mirone; last stable release v7.20.0 on 2025-03-30 (> 12 months). Main branch is active but the release cadence trigger from the v1 ADR has already fired.
- **BlockNote** is team-maintained (4 core devs + 10+ community contributors); releases v0.45 → v0.48.1 across Dec 2025–Apr 2026 (every 2–4 weeks). Funded by **ZenDiS (OpenDesk)** and **DINUM (La Suite Docs)** — the latter is a production deployment for thousands of French public servants editing concurrently. BlockNote presented at **FOSDEM 2026** on "BlockNote, ProseMirror and Yjs 14: Versioning and Track Changes" jointly with Kevin Jahns (Yjs creator).

## Options considered
- **BlockNote** (MPL-2.0, ProseMirror + block model) — first-class Yjs collab, native block IDs, declarative typed block schema (`createReactBlockSpec`) that maps cleanly to ADR 0013 v2's per-block fidelity tiers. `BlockNoteEditor.create({ collaboration: { fragment } })` inside Hocuspocus `openDirectConnection.transact()` is our unified write primitive (ADR 0018). AriaKit accessibility baseline. `@blocknote/xl-*` (AI, PDF/Word export, multi-column) packages are GPL-3.0 for OSS + commercial for closed-source.
- **Tiptap v3** (MIT) — substrate that BlockNote runs on top of. Reconsidered in the April 2026 BlockNote research pass. v3 closes the server-side-edit and markdown-hooks gaps (added `@tiptap/markdown`, `@tiptap/static-renderer`, documented server-side execution). What's still missing vs BlockNote: declarative block schema with typed props + IDs; the Notion-like UX chrome (slash menu is experimental; side menu is DIY). Realistic cost to match BlockNote on Tiptap direct: 2–4 engineer-weeks for UX chrome + bespoke block-spec layer. Tiptap's Version History is Pro-only.
- **Milkdown** (MIT) — remark-native round-trip was the entire reason to pick it under ADR 0013 v1; with the constraint relaxed in v2, the ergonomic cost (no native block IDs, block-identity ops are tree walks, per-block contracts scattered across remark plugins) and solo-maintainer signal (last stable v7.20.0, 2025-03-30) flip the comparison.
- **Lexical / ProseMirror direct** — evaluated in v1; unchanged reasons to skip for this role.

## Decision
**BlockNote.** `@blocknote/core` + `@blocknote/react` + `@blocknote/ariakit` in the frontend; `BlockNoteEditor.create({ collaboration: { fragment } })` inside Hocuspocus `openDirectConnection.transact()` on the backend (see ADR 0018 for the full write path).

`@blocknote/server-util`'s `ServerBlockNoteEditor` is used only as a **conversion surface** (blocks ↔ HTML/Markdown/Y.Doc for initial import, projections, agent readbacks). It does not provide `transact()` or block-mutation methods — those live on `BlockNoteEditor`.

- Accessibility: start on **`@blocknote/ariakit`** (AriaKit primitives) — best WCAG 2.1 AA starting point of the three official UI variants.
- `@blocknote/xl-*` (GPL-3.0) packages: GPL-3.0 + AGPL-3.0 **are** compatible (FSF GPL FAQ §13). The real constraint: adopting any `xl-*` package makes the combined work **irreversibly copyleft** — forecloses any future permissive or dual-license move. Consistent with ADR 0001's AGPL + DCO posture. Adopt opportunistically when the feature value (e.g., PDF export) clears that bar; default is to build AI assist at the capability layer (ADR 0009) rather than via `xl-ai` so agent behavior lives on our controlled surface.
- **Funding signal** (strengthens bus-factor posture): BlockNote is jointly financed by **DINUM** (France's digital-gov agency, deploying BlockNote in production in La Suite Docs) and **ZenDiS** (Germany's digital-sovereignty center, OpenDesk program). Presented at FOSDEM 2026 with Kevin Jahns (Yjs creator) on "BlockNote, ProseMirror and Yjs 14: Versioning and Track Changes." Two EU governments with line-item procurement is a stronger survival signal than star-count.

## Consequences
- Block IDs are native — delete the directive-attribute ID scheme from ADR 0013.
- Agent `doc.update` via MCP (ADR 0009) constructs `editor.insertBlocks/updateBlock/removeBlocks` calls inside `editor.transact(...)`, wrapped by Hocuspocus `openDirectConnection.transact()`. Multi-op intents collapse to one ProseMirror transaction → one Yjs update → one `onChange` → one audit row.
- Custom blocks use `createReactBlockSpec({ type, propSchema, content }, { render, toExternalHTML })`; attach `toMarkdown` / `fromMarkdown` per block to declare the fidelity contract (ADR 0013 v2 tiers).
- FOSDEM 2026's Yjs 14 track-changes work lands upstream through BlockNote — we inherit versioning / track-changes primitives without owning them.
- License note: MPL-2.0 core is AGPL-3.0-compatible one-way. Document the GPL-3.0 surface of any `xl-*` packages adopted in `THIRD_PARTY.md`.
- Ejection path if BlockNote stalls: 1–3 months of focused work to rebuild block-spec wrapper + slash/side-menu UI on raw Tiptap; Y.Doc state and Hocuspocus pipeline unchanged. Legible fallback, not a rewrite.

## Revisit triggers
- BlockNote team dissolves or pivots commercial-only in a way that blocks us from shipping what we need.
- A P0 block type cannot be expressed within BlockNote's schema model and requires dropping to direct ProseMirror — in which case raw Tiptap is the ejection target.
- `@blocknote/xl-*` GPL-3.0 licensing conflicts with a downstream distribution we commit to (not an issue for pure AGPL self-hosters or us).
- La Suite Docs / OpenDesk funding disappears and release cadence regresses beyond 6 months.
