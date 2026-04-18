# ADR 0013 — Block model: CRDT-as-source-of-truth with per-block-type Markdown fidelity

**Status:** Accepted (post-refresh, supersedes v1 "Markdown AST as source of truth"; markdown block-ID anchor syntax deferred per [ADR 0022](0022-agent-editing-constraints.md))
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

> **[ADR 0022](0022-agent-editing-constraints.md)** formalizes that the markdown block-ID anchor *syntax* (HTML comments vs `remark-directive {#id}` vs none) remains an *open question* pending agent traffic. The `preserveBlockIds` flag stays as the implementation knob; formal syntax choice is deferred to the agent-ergonomic wrapper ADR.

## Context
v1 decided "Markdown AST is the source of truth; CRDT reflects it." That was a direct translation of a naive user pointer (versioned-S3-of-Markdown). The pointer was retracted and the right shape is **CRDT (Yjs) is the source of truth; Markdown is a faithful-where-possible projection with per-block-type fidelity contracts.**

Research (Phase 1 v2) surveyed prior art: BlockSuite / Affine ship this model with a named **Transformer (lossless Y.Doc snapshot) vs Adapter (declared-lossy Markdown)** split; Outline runs Yjs-as-truth at scale; Logseq's migration away from Markdown-as-storage confirms the anti-pattern; HedgeDoc v2 is the inverse case. No published RFC formalizes a three-tier fidelity contract; we're the first to write it down cleanly.

## Options considered
- **(A) Markdown AST as source of truth** (v1). Forces every block to express cleanly as CommonMark + directives; richness ceiling; agents reason in mdast nodes.
- **(B) Notion-style first-class blocks, Markdown export = lossy by design.** Removes fidelity rigor entirely; git-mirror workflow degrades; portability story weak.
- **(C) CRDT as source of truth; per-block-type Markdown fidelity contracts.** Lossless where possible, declared-lossy where not; agents reason in blocks; Markdown export honest; portability workflows (git-mirror, ADR 0020) work for the lossless majority.

## Decision

**Option C. CRDT (Yjs) is the source of truth. Markdown is a per-block-type-declared projection.**

### Three-tier fidelity contract

Each block type in our schema (via BlockNote's `createReactBlockSpec`, ADR 0004) declares one of three tiers:

1. **`lossless`** — block → markdown → block is bit-identical under a declared equivalence relation.
   Examples: prose, headings, lists, code blocks, tables, links, basic inline formatting (bold, italic, code).
   Implementation: `toMarkdown` emits canonical CommonMark / GFM per the locked parser version; `fromMarkdown` round-trips through the same parser.

2. **`directive`** — block → markdown → block round-trips through a declared remark-directive shape `:::type{attrs}...:::` or inline `::type[text]{attrs}`.
   Examples: callouts, Mermaid, KaTeX, embed cards, mentions, admonitions, video/file attachments.
   Implementation: `toMarkdown` emits the directive with all attributes; `fromMarkdown` parses via `mdast-util-directive` and reconstructs the block. Directive type name carries `namespace:name` flavor (BlockSuite pattern) to prevent third-party collisions.

3. **`opaque`** — block → markdown emits a declared fallback representation that does NOT round-trip to the original block; re-import creates a `opaque` block with `_type` + `id` preserved.
   Examples: inline databases, interactive embeds, platform-specific components, rich filtered views.
   Implementation: `toMarkdown` emits an HTML comment capturing block type + attributes (`<!-- editorzero:opaque type="..." id="..." attrs="..." -->`) plus an optional rendered text fallback for human readability. `fromMarkdown` reconstructs an `opaque` placeholder.

### Block IDs
Native in Yjs / BlockNote — each block has a persistent `id` attribute carried in the CRDT. Survives all CRDT operations. On Markdown export:
- **`lossless` blocks:** ID encoded as a trailing `<!-- id:abc123 -->` HTML comment only if `preserveBlockIds: true`; stripped by default for clean git diffs.
- **`directive` / `opaque` blocks:** ID is always an attribute in the directive / HTML-comment wrapper.

On import from Markdown without an ID marker, blocks are assigned fresh CRDT-generated IDs. Users who want stable IDs across round-trip enable `preserveBlockIds`.

### Canonical shapes (references)
- Directive node shape: `mdast-util-directive`'s JSON (https://github.com/syntax-tree/mdast-util-directive).
- Block type flavor naming: BlockSuite's `namespace:name` (`@blocksuite/blocks`'s `@blocksuite:code`, `@blocksuite:callout`). We use `editorzero:core/heading`, `editorzero:core/code`, `third-party-plugin:custom-block`.

### Property test harness (Phase 3 deliverable)
Per-block-type fuzzed round-trip:

```
for each block type T:
  for each declared fidelity tier contract:
    generate N canonical fixtures of T
    for each fixture block:
      md = T.toMarkdown(block)
      block' = T.fromMarkdown(md)
      assert block ≡ block' under T.equivalence
```

Plus a **multi-block document round-trip**:

```
for each fuzzed doc D (N blocks across all types):
  md = doc_to_markdown(D)
  D' = markdown_to_doc(md)
  assert D ≡ D' under "all non-opaque blocks bit-identical; opaque blocks preserve _type + id"
```

Runs on every PR; 10k rounds default, 1M nightly. A PR that breaks any declared contract fails CI.

### Import determinism
- Parser version locked (remark-parse + remark-directive, pinned).
- Unicode NFC normalization applied identically on import and any later diff.
- Whitespace collapsed identically (one trailing newline, no internal tab-vs-space ambiguity).
- Directive attributes treated as unordered maps (order-independent equality).

### Git-mirror interaction (ADR 0020)
The git-mirror writes the multi-block Markdown projection. Lossless + directive blocks round-trip perfectly through the mirror. Opaque blocks surface as HTML comments + human-readable fallback; importing from the mirror reconstructs opaque placeholders. Users see honest diffs and know when a block is round-trip-safe.

### Escape hatch for block-schema migrations
Per BlockSuite's explicit warning ("no central source of truth in a CRDT editor, add props as *optional*"): schema changes add optional props, never required ones. Mandatory changes go through a CRDT-layer migration job (ADR 0014) that reads old-schema blocks, writes new-schema blocks, and drops the old via soft-delete (ADR 0017).

## Consequences
- Markdown round-trip is verifiable, per-contract, not a monolithic claim.
- Agent authoring via MCP `doc.update` can submit either block JSON (precise) or Markdown (natural) — both land in the CRDT via the unified write path (ADR 0018).
- Rich block types (inline databases, interactive embeds) are possible without fighting a serializer.
- Git-mirror (ADR 0020) has honest semantics: users see full fidelity for lossless+directive blocks; opaque blocks are flagged.
- Property test harness is the lynchpin — fidelity is proven per block type on every PR.
- We pay a small complexity cost in the block-type registration path (each type declares its tier + implements `toMarkdown`/`fromMarkdown` per the tier contract).

## Revisit triggers
- A required UX feature cannot be expressed in any of the three tiers cleanly (e.g., block state that must not be in the Markdown projection under any representation).
- Unicode normalization produces unexpected idempotency failures we cannot pin through.
- The property-test harness surfaces a class of serializer bugs in remark / directive parsing that blocks a release.
- Demand for a fourth tier emerges (e.g., "partial round-trip" with declared lossy fields).
