# ADR 0004 — Rich-text editor: BlockNote

**Status:** Accepted (post-refresh, supersedes v1 Milkdown decision)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

## Context
ADR 0013 v1 made "Markdown AST is the source of truth" a monolithic hard invariant, which uniquely qualified Milkdown (remark-under-the-hood) as the editor. ADR 0013 v2 relaxes that: **the CRDT (Yjs) is the source of truth; each block type declares its own Markdown fidelity contract.** Under the relaxed constraint, the editor choice is re-opened.

Additional signals from the April 2026 refresh:
- **Milkdown** is effectively solo-maintained by Mirone; last stable release v7.20.0 on 2025-03-30 (> 12 months). Main branch is active but the release cadence trigger from the v1 ADR has already fired.
- **BlockNote** is team-maintained (4 core devs + 10+ community contributors); releases v0.45 → v0.48.1 across Dec 2025–Apr 2026 (every 2–4 weeks). Funded by **ZenDiS (OpenDesk)** and **DINUM (La Suite Docs)** — the latter is a production deployment for thousands of French public servants editing concurrently. BlockNote presented at **FOSDEM 2026** on "BlockNote, ProseMirror and Yjs 14: Versioning and Track Changes" jointly with Kevin Jahns (Yjs creator).

## Options considered
- **BlockNote** (MPL-2.0, ProseMirror + block model) — first-class Yjs collab, native block IDs, `@blocknote/server-util`'s `ServerBlockNoteEditor` is a ready-made synthetic-client for our unified write path (ADR 0018). AriaKit accessibility baseline. `@blocknote/xl-*` (AI, PDF/Word export, multi-column) packages are GPL-3.0 for OSS + commercial for closed-source; compatible with our pure-AGPL posture if we adopt.
- **Milkdown** (MIT) — remark-native round-trip was the entire reason to pick it; with the constraint relaxed, the ergonomic cost (no native block IDs, block-identity ops are tree walks, per-block contracts scattered across remark plugins) and the maintainership signal flip the comparison.
- **Tiptap v3**, **Lexical**, **ProseMirror direct** — evaluated in v1; unchanged reasons to skip for this role.

## Decision
**BlockNote.** `@blocknote/core` + `@blocknote/react` in the frontend; `@blocknote/server-util`'s `ServerBlockNoteEditor` in the backend for synthetic-client writes (see ADR 0018).

- Accessibility: start on **`@blocknote/ariakit`** (AriaKit primitives) — best WCAG 2.1 AA starting point of the three official UI variants.
- `@blocknote/xl-*` (GPL-3.0) packages: adopt opportunistically when their features (AI assist, PDF export) are needed; they cascade GPL-3.0, which is compatible with our AGPL-3.0 project but incompatible if we ever relicensed weaker (we won't — DCO commitment, ADR 0001).

## Consequences
- Block IDs are native — delete the directive-attribute ID scheme from ADR 0013.
- Agent `doc.update` via MCP (ADR 0009) constructs `editor.transact()` calls with `insertBlocks`/`updateBlock`/`removeBlocks` against a `ServerBlockNoteEditor` bound to the live `Y.XmlFragment` loaded from Hocuspocus. Multi-op intents collapse to one undo step.
- Custom blocks use `createReactBlockSpec({ type, propSchema, content }, { render, toExternalHTML })`; attach a `toMarkdown` method per block to declare the fidelity contract (ADR 0013 v2 tiers).
- FOSDEM 2026's Yjs 14 track-changes work lands upstream through BlockNote — we inherit versioning / track-changes primitives without owning them.
- License note: MPL-2.0 core is AGPL-3.0-compatible one-way. Document the GPL-3.0 surface of `xl-*` packages in `THIRD_PARTY.md` when adopted.

## Revisit triggers
- BlockNote team dissolves or pivots commercial-only in a way that blocks us from shipping what we need.
- A P0 block type cannot be expressed within BlockNote's schema model and requires dropping to direct ProseMirror.
- `@blocknote/xl-*` GPL-3.0 licensing conflicts with a downstream distribution we commit to (not an issue for pure AGPL self-hosters or us).
- La Suite Docs / OpenDesk funding disappears and release cadence regresses.
