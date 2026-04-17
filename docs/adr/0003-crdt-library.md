# ADR 0003 — CRDT library: Yjs with resource limits

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Concurrent editing between humans and AI agents requires a CRDT. Scale target: up to 50k-op docs, up to 20 concurrent editors per doc, long-lived sessions. Editor ecosystem coupling is the dominant selection pressure — whichever CRDT has mature editor bindings wins because we cannot afford to maintain editor glue ourselves.

## Options considered
- **Yjs** — most mature ecosystem: first-party ProseMirror/Tiptap/Lexical/BlockNote/Milkdown bindings; production at LinkedIn/GitLab/Anthropic; stable v13 binary format. Weaknesses: bus-factor concentrated on Kevin Jahns; native branching/time-travel is thin; server-side memory at very large docs has community-reported leak patterns.
- **Loro** — Rust core, compact, first-class time-travel and branches. Official ProseMirror binding is beta; no Tiptap/Milkdown/Lexical wrappers. Smallest maintainer team.
- **Automerge v3** — history primitives are best-in-class; v3 fixed earlier memory issues; ProseMirror binding is beta and there is no Tiptap/Milkdown wrapper. Too much editor-ecosystem debt for a product whose primary surface is rich text.

## Decision
**Yjs.**

## Resource limits (red-team finding 6)

Yjs updates can be crafted to be pathologically large (deep nested types, huge strings in single transactions, adversarial map fan-out). We enforce, server-side in the Hocuspocus update handler (ADR 0006) and in the API/MCP capability layer (ADR 0015):

- **Per-update byte cap:** 256 KB. Reject larger updates with an error the client can surface.
- **Per-session update rate cap:** 100 updates/sec, burst 200. Excess buffered; sustained excess drops the session.
- **Per-doc total-state cap:** 50 MB serialized state. On breach, doc enters read-only mode and is flagged for operator review; users see a "This document is too large — split it" message.
- **Server-side apply-pass:** every update passes through a validating `Y.Doc.applyUpdate` in a worker-thread sandbox; if applying produces a state-delta that exceeds per-update byte cap (post-apply), the update is rejected.
- **Agent-vs-human limits:** agent principals get the same per-session caps but a separate audit-log rate limit (ADR 0016, §rate-limits) so a runaway agent cannot flood audit.

These are defaults; operators can tune via env vars. Limits are surfaced through OpenTelemetry counters (ADR 0019) so breaches are observable.

## Consequences
- Mature, battle-tested editor bindings via `y-prosemirror` (through Milkdown's `@milkdown/plugin-collab`).
- Native time-travel / branching is weak; we layer a history stack on top of periodic snapshots + the updates log (ADR 0007).
- Server-side Yjs access is native in Node (ADR 0002) — Markdown export, search indexing, audit all run in-process.
- Resource limits protect against CRDT payload abuse (red-team #6); a hostile client cannot OOM a server or fill a doc past ceiling.
- Accept Kevin Jahns bus-factor risk; pin versions, contribute fixes upstream, keep a Loro migration plan warm.

## Revisit triggers
- AI agent branch/merge UX becomes a first-order product feature and Yjs snapshots-as-history cannot express it; Loro becomes the better fit.
- Yjs maintainer engagement drops below 1 release/quarter.
- A load test (20 concurrent editors × 100k-op doc) reveals a memory or convergence bug we cannot mitigate server-side.
- Resource limits prove insufficient — a new class of CRDT payload abuse surfaces.
