# ADR 0013 — Block model: Markdown AST as source of truth

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
The Phase 0 self-critique flagged this as a distinct architectural fork: Notion-style block model (blocks are first-class records; Markdown is lossy export) vs. Markdown AST (mdast tree *is* the model; Markdown round-trip is lossless). This decision shapes the CRDT schema, the editor invariants, and long-term import/export fidelity.

Red-team (#7) flagged the hidden coupling between the Yjs document and the Markdown AST: round-trip determinism requires every Milkdown/ProseMirror operation to produce a remark-directive-preserving serialization whose re-parse reconstructs an identical doc. Any schema or plugin change breaks this silently without a property-test harness.

## Options considered
- **Notion-style block model** — blocks are first-class DB rows with IDs, types, parents, positions; Markdown round-trip is lossy by design.
- **Markdown AST as source of truth** — the doc *is* a remark mdast tree; blocks = AST nodes; non-Markdown primitives expressed as remark-directives (`:::type`); round-trip is lossless by construction.

## Decision
**Markdown AST (remark mdast) is the source of truth.** Non-Markdown primitives encoded as **remark-directives** per the CommonMark directive draft (`:::type[attrs]...:::`). Durable block IDs (for deeplinks, per-block comments, drag operations) stored as directive attributes (e.g., `{#id=abc123}`) so Markdown round-trip is preserved.

### Round-trip property test harness (red-team #7) — Phase 3 deliverable

The harness is the lynchpin that makes the whole decision honest. It runs in CI on every PR.

**Shape:**
1. Generate N canonical Markdown documents from a fuzzer (block-type-weighted, with depth and width constraints).
2. For each doc:
   a. Parse to mdast (`remark-parse` + directive extensions).
   b. Construct a Yjs `Y.Doc` reflecting the mdast (via our `mdast ↔ y.doc` bridge).
   c. Apply R randomized edit operations (insert, delete, move, update block attributes) through the same capability-layer code path that the editor uses.
   d. Serialize back: `y.doc → mdast → Markdown`.
   e. Re-parse: `Markdown → mdast'`.
   f. Assert `mdast' ≡ mdast` structurally, modulo whitespace we've explicitly declared non-semantic.
3. Corpus: 10k rounds per PR by default, 1M rounds nightly.

**Invariants the harness enforces:**
- **Fixed point.** `md → crdt → md` is a fixed point for any canonical input.
- **Durable IDs.** Every block ID present after edit `i` is either present in the final state (alive) or appears in the delete audit log (removed). IDs never silently disappear.
- **Structural equivalence of reparsed output.** No serializer loss.

**Failure mode of the test:** any schema change in Milkdown, any remark plugin update, any new block type that doesn't round-trip cleanly fails the harness. CI fails. We cannot land a change that breaks the invariant silently.

## Consequences
- The round-trip invariant is by construction at the storage layer *and* proven by the property test.
- Milkdown consumes the same mdast — no editor-vs-storage impedance.
- New block types contract: (a) directive spec, (b) renderer (React component), (c) CRDT schema entry, (d) property-test coverage. Documented process.
- Block-ID features (comments, deeplinks, drag) work by attaching attributes to AST nodes; no shadow-block table.
- Notion imports that use non-Markdown semantics (e.g., synced blocks, databases) are mapped to directives where possible; unsupported constructs are documented as gaps.

## Revisit triggers
- A UX feature that cannot be expressed cleanly as a directive (e.g., block state that must not be in the Markdown).
- The property-test harness surfaces a class of serializer bugs the Milkdown+remark stack cannot fix.
- mdast / remark evolves in a direction that breaks directive stability.
