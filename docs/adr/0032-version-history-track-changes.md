# ADR 0032 — Version history and track-changes: build ourselves on Yjs snapshots + prosemirror-changeset

**Status:** Accepted (2026-05-30)
**Date:** 2026-05-29
**Deciders:** @numman (track-changes confirmed near-term core; build-vs-buy determination delegated to Claude Opus 4.8; review `wf_b3e0aac1-bff`)

## Context

Nomi: *"[track-changes / version-history] is near term, part of core offering — I don't know enough about what BlockNote has done that makes it required, I lean on you to tell me whether we build ourselves or rely on BlockNote."* This ADR answers that call.

The review verified the vendor landscape:

- **Tiptap's track-changes / version-history are Pro / Enterprise-only** — not in the MIT-open extension set. Relying on them means a paid, hosted-leaning dependency inside an AGPL self-hostable platform. Disqualifying for the core offering.
- **BlockNote's track-changes is an unshipped upstream Yjs-14 bet** (FOSDEM 2026). Betting the core offering on someone else's unshipped work is the exact dependency ADR 0031 ejects.
- **The free primitives are first-class and ours to compose.** **Yjs snapshots** (`Y.snapshot` / `Y.encodeStateAsUpdate` / `Y.createSnapshot`) and **`prosemirror-changeset`** are MIT. Yjs versioning over snapshots is the documented, supported path; `prosemirror-changeset` is the canonical diff/decoration engine. Both are free, self-hostable, and already in our engine's family.

Neither vendor gives **free + self-hostable** track-changes. So "rely on a vendor" is not actually on the table for the core offering — the real choice is *build on the free primitives* vs. *don't have the feature*. And editorzero's distinctive requirement is one no vendor targets: **tracked *agent* edits** — agents are first-class principals (ADR 0016), so a suggestion/change must attribute to a human *or* an agent identity, flow through the dispatcher, and produce audit entries like any other mutation.

## Decision

**Build version history and track-changes ourselves, as editorzero capabilities, on Yjs snapshots + `prosemirror-changeset`.** This is what makes the ADR 0031 Tiptap-v3 + owned-schema ejection near-term: owning track-changes requires schema sovereignty, so the two slices fuse.

- **Version history = named Yjs snapshots, dispatcher-mediated.** A version capability records a Yjs snapshot (state vector + encoded state) with author attribution (human or agent) and one audit entry (invariant 3). Restore is an inverse operation through `ctx.transact` (invariant 7) producing its own audit entry — it does not rewrite history, it appends a converging state (invariant 2 preserved). The version index is metadata surfaced via the typed RPC (ADR 0028/0029) and cached by TanStack Query, not by the live CRDT channel.
- **Track-changes = `prosemirror-changeset` over snapshots, expressed in the owned schema.** Suggestions (proposed insertions/deletions) live as marks/decorations in the owned ProseMirror schema (ADR 0031) — *why* Phase 2 owns the schema. Computing what changed between two versions, and rendering accept/reject affordances, is `prosemirror-changeset`'s job; accept/reject are capabilities that apply through `ctx.transact` with audit attribution.
- **Tracked agent edits are the differentiator and a first-class path.** An agent's edit can be recorded as a *suggestion* attributed to the agent principal, reviewable/acceptable by a human (or another authorized agent) — the same accept/reject capability, a different principal. This is the feature no vendor targets and the reason owning the stack pays off. Rate limits, audit attribution, and revocation for agent-authored suggestions inherit ADR 0016.
- **Full surface parity (invariant 4).** Version/track-changes capabilities exist on API / CLI / MCP / Web UI like every capability — diffing a doc or accepting a suggestion from the CLI or via MCP is in-contract, enforced by the ADR 0033 contract matrix. (This is itself an argument against a UI-vendor-only feature: a BlockNote-React-only track-changes UI could not satisfy parity.)

### Design commitments (the parts `prosemirror-changeset` does not decide)

`prosemirror-changeset` is a diff/decoration primitive, **not** a live-suggestion model. The model is ours; these four choices are load-bearing and decided here, not deferred (Codex review):

- **Restore appends, never rewinds.** Yjs updates are monotonic — a `Y.Doc` cannot be rolled back in place. "Restore version N" computes the delta between current state and snapshot N and applies it as a **new corrective update** through `ctx.transact` (invariant 7), yielding a converging state (invariant 2) and one audit entry (invariant 3). Old states stay in history; restore is forward motion to an equivalent state, never a rewind.
- **Suggestion anchors are Yjs `RelativePosition`, not ProseMirror offsets.** A suggestion must survive concurrent edits to surrounding text. Absolute PM offsets — and any external offset table — break under concurrent insert/delete; Yjs relative positions remap stably across them. The anchor (start/end `RelativePosition`) is stored with the suggestion; the suggestion's **metadata** (author principal, status, timestamps) lives in a dispatcher-tx metadata table (queryable, parity-surfaced), but the **position** is a relative position resolved against the live doc.
- **Accept/reject is conflict-aware.** Accept resolves the anchor against current state and applies through `ctx.transact`. If the anchored range no longer resolves (its content was concurrently deleted), the suggestion is **stale/void** — surfaced as "outdated", never silently applied at the wrong place. Reject discards the suggestion (soft-delete, recoverable — invariant 6). Both emit audit entries.
- **Retention is explicit-version-first.** v1 records only **explicitly named** versions — no background auto-snapshot churn — so retention is user-driven and a deleted version is a soft-delete (invariant 6); "GC" is recovery-window expiry of soft-deleted versions, not a background reaper over implicit snapshots. Auto-snapshot cadence (and its GC policy) is a deliberate later addition, not v1.

## Consequences

- **The killer feature is owned, free, and self-hostable** — no Pro/Enterprise gate, no unshipped-upstream dependency, AGPL-clean.
- **We own the hard parts.** Snapshot retention/GC, diff performance on large docs, and conflict semantics when a suggestion's anchor moves under concurrent edits are now ours to solve and test. `prosemirror-changeset` handles diff mechanics; *policy* (retention windows, suggestion lifecycle, agent-suggestion rate limits) is ours. Property tests (invariant 2 convergence, invariant 3 one-audit-entry, invariant 6 recoverable soft-delete for discarded suggestions) gate it.
- **Couples this slice to ADR 0031 Phase 2.** Track-changes wants the owned schema, so it cannot ship on the BlockNote bootstrap — it lands with (or just after) the Tiptap ejection. Sequenced explicitly so neither blocks the *rest* of the Web UI.
- **Versioning is independent of track-changes and can lead.** Yjs-snapshot version history needs only snapshot capabilities + the dispatcher — it does **not** require the owned schema, so it can ship on the BlockNote bootstrap if we want versioning before the Tiptap ejection. Track-changes (suggestion marks) is the part that waits for schema sovereignty.
- **Determinism / convergence preserved.** Snapshots and changesets are computed *over* the CRDT, not in place of it; restore appends a converging state rather than rewriting. The CRDT remains the source of truth.

## Revisit triggers

- **A genuinely free + self-hostable + parity-capable vendor track-changes appears** (MIT-licensed, schema-agnostic, agent-attributable): re-weigh build-vs-buy — though owning the schema (ADR 0031) and agent attribution (ADR 0016) keep the build attractive.
- **Snapshot storage growth or diff latency on large docs becomes a real cost**: revisit retention/GC policy and consider incremental-snapshot or server-side diff caching; this is a tuning revisit, not an architecture reversal.
- **Yjs `RelativePosition` anchoring proves insufficient for a suggestion class** (e.g. structural block-move suggestions rather than inline-text edits): evaluate a heavier CRDT-native suggestion model **for that class only**, before generalizing it across all suggestions.

## Cross-references

- **Fused with** ADR 0031 (owned Tiptap-v3 schema — the schema sovereignty this needs). **Reverses the premise of** ADR 0004 (inherit track-changes from BlockNote).
- **Builds on** ADR 0016 (agent principals — tracked agent edits, rate limits, revocation), ADR 0018 (`ctx.transact` write path), the raw-Yjs collab layer.
- **Surfaced via** ADR 0028/0029 (typed RPC), gated by ADR 0033 (contract-matrix parity), bound by invariants 2/3/4/6/7.
