# ADR 0004 — Rich-text editor: Milkdown

**Status:** Proposed (pending red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
The hard invariant is Markdown round-trip determinism: `md → crdt → md` is a fixed point for canonical input. The editor must also integrate with Yjs, accept programmatic edits from agents concurrent with user keystrokes, support custom blocks (Mermaid, KaTeX, tables, syntax-highlighted code, checklists, attachments), and meet WCAG 2.1 AA.

## Options considered
- **Tiptap v3** — ProseMirror-based; best Yjs binding in the ecosystem; but `tiptap-markdown` (and the paid Tiptap Pro Markdown extension) inherit `prosemirror-markdown`'s serializer losses: bullet/emphasis normalization, setext→ATX, reference-link rewriting. Disqualified for the round-trip invariant unless we write our own serializer.
- **Lexical** — Meta, MIT; strong accessibility, but Markdown is explicitly transform-based — not designed to round-trip.
- **ProseMirror direct** — total control with a hand-written remark-backed serializer; 6–12 engineer-months to reach Tiptap feature parity.
- **Milkdown** — MIT, ProseMirror + remark pipeline; the only candidate where Markdown is the canonical source of truth rather than an export format; Yjs collab via `@milkdown/plugin-collab` wrapping the mature `y-prosemirror`. Solo-maintainer (Mirone) risk.
- **BlockNote** — MPL-2.0, block-model; its docs explicitly state Markdown export is lossy. Disqualified.

## Decision
**Milkdown.**

## Consequences
- Markdown round-trip is by construction, not by discipline. Agents can author in Markdown and we parse → AST → CRDT → AST → Markdown with no information loss.
- Custom blocks implement as remark plugins (AST) + ProseMirror node views (rendering). Mermaid, KaTeX, callouts all have established remark plugin precedents.
- Concurrent programmatic edits are safe as long as all mutations go through the Yjs doc (enforced via the collab plugin), not directly against the ProseMirror view.
- Solo-maintainer risk is real; mitigations: (a) pin versions, (b) contribute PRs upstream, (c) keep our block/custom-node code thin enough that we could switch to direct ProseMirror + remark-stringify without rewriting UX.
- Accessibility gaps in the default UI will require targeted work before Phase 5.

## Revisit triggers
- Milkdown release cadence falls below 1 release per quarter or Mirone declares the project unmaintained.
- A round-trip construct we need cannot be expressed through the remark AST + directive extensions.
- A P0 custom block type requires ProseMirror access Milkdown does not expose.
