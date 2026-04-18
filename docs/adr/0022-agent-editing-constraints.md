# ADR 0022 — Agent-editing constraints on block capabilities

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** @numman

## Context

ADR 0013 locked the data model (CRDT as source of truth, per-block Markdown fidelity tiers). ADR 0018 locked the write path (`ctx.transact`, single-tx audit + content). What **remains open** is the *input-side* contract for per-op block mutations: specifically, whether ops inside `doc.update` carry any "expected prior state" hint, and what shape reserved-for-future fields should take.

This question becomes one-way the moment block capabilities ship. The other agent is landing block-level work now; adding precondition fields after the capability is generated across four surfaces + contract tests is a breaking change. Conversely, *reserving* the field now is cheap and keeps every door open.

### Research (2026-04-18) — what production systems actually do

Three mature patterns coexist:

- **`If-Match` ETag + HTTP 412** (Microsoft Dataverse, Square, Atom-style REST). Classic, well-specified (RFC 7232).
- **`expected_revision` / `version` in payload** (Linear GraphQL, Marten `IfVersionMatches`). Monotonic per-resource counter.
- **No optimistic concurrency, content-addressed selection instead** (Notion's hosted MCP). `selection_with_ellipsis: "# Old Section...end"` — the selector IS the precondition; a missed match is a no-op or reject.

The [Outline #9521 bug](https://github.com/outline/outline/issues/9521) documents the failure mode we must engineer against: a REST write path and a Y.js WebSocket path with split authority caused silent overwrites of API-originated edits by subsequent human saves. Our invariant 7 (single write path through `ctx.transact`) closes this on the *write* side. The *read→edit gap* — agent reads block, thinks, submits update minutes later — is where it can still sneak in, and that gap is exactly the window `expect_prior_content_hash` closes.

Claude Code's `Edit(old_string, new_string)` works not because exact-match is clever in itself, but because **uniqueness of match acts as a one-shot optimistic-concurrency check**: a second writer who modifies the region invalidates the match and the edit fails closed. That principle translates to blocks cleanly — the equivalent is "hash of prior block state that the agent saw" (cf. Anthropic, [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents); [Text editor tool docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/text-editor-tool)).

### What's in code today

Architecture.md §16.3 `doc.update_batch` ops (the audit effect shape, also the input op shape):

```ts
| { op: "insert"; block: BlockPostState; after_block_id; parent_block_id }
| { op: "update"; block_id: BlockId; post: BlockPostState }
| { op: "move";   block_id: BlockId; new_parent_block_id; new_order_key }
| { op: "remove"; block_id: BlockId; preimage: BlockPostState }
| { op: "set_visibility"; block_id: BlockId; visibility }
```

**No precondition fields.** `doc.update_from_markdown` has `reconcile_base_token` at whole-doc scope (§6.6); `doc.update` at per-op scope does not.

## Options considered

### A. Do nothing now; add precondition fields later when needed.

Cost: at the point of need, every adapter (API / CLI / MCP / UI) regenerates, every contract-test cell reshapes, every client integration rebuilds. The longer we wait, the more callers the change breaks.

### B. Codify a rich multi-field precondition vocabulary now (ETag + version + selector).

Matches several production systems simultaneously, but bakes in an answer to "which shape wins" that we don't yet know. Over-fits.

### C. Reserve the *minimal* precondition surface now; defer full ergonomic wrappers — CHOSEN

Add **one** optional per-op field (`expect_prior_content_hash`) plus a reserved policy discriminator (`precondition_policy?`). Ship v1 with strict-reject-on-mismatch behaviour. Reserve a sibling on `AccessPath` for content-addressed (markdown-anchor) selectors. Defer the full Read/Grep/Edit-shaped wrapper ADR to post-traffic evidence.

This buys the optionality at minimum cost and matches the project's "capture non-reversible decisions early, defer evidence-dependent ones" pattern (cf. surface-transport decision in [ADR 0021](0021-surface-transport-topology.md), TOON eval deferred until traffic exists).

## Decision — what this ADR codifies

### 1. Per-op `expect_prior_content_hash` on `doc.update` ops

Applies to ops that target an existing block: `update`, `move`, `remove`, `set_visibility`. (Not `insert` — no prior state.)

```ts
{ op: "update"; block_id: BlockId; post: BlockPostState;
  expect_prior_content_hash?: string;        // sha256-hex of prior block canonical JSON
  precondition_policy?: "strict";            // reserved; v1 supports "strict" only
}
```

- **Shape**: SHA-256 hex over canonicalized prior block JSON. Canonicalization rule = the same one used for `input_hash` in audit (`canonicalize` + `JSON.stringify` + `sha256`, architecture.md §9 / dispatcher.ts). Single hashing primitive for the whole system.
- **Semantics**: when present, the handler verifies inside `ctx.transact` that `sha256(canonicalize(currentBlock)) === expect_prior_content_hash` *before* applying the op. Mismatch → throw `StalePreconditionError`. The transact closure has not yet committed; no partial write lands.
- **When humans omit it**: BlockNote in the browser writes through Hocuspocus with Yjs-native concurrency semantics; the editor never needs to send the hash. Field stays optional precisely so the human path is unchanged.
- **When agents send it**: agents that read the block (directly or via `doc.get_markdown`) compute the hash from what they saw. Mismatch == the block moved under them == fail closed + tell the agent to refetch.

### 2. `StalePreconditionError` as a first-class error variant

Registered in `packages/errors` as a subclass of `EditorZeroError` with its own `toHandlerError()` per F95 (Defend-These). Surface mapping:

| Surface | Shape |
|---|---|
| API | HTTP 412 + RFC 9457 problem body with `conflict.block_id` + `conflict.current_hash` |
| CLI (AXI) | Exit code 9 + structured envelope on stdout: `{ error: { code: "stale_precondition", block_id, current_hash, hint: "Re-read the block and retry with fresh hash." } }` |
| MCP | JSON-RPC typed error; returns `{ isError: true, content: [...] }` with the hint suitable for agent loop |
| UI | Not reachable — the web editor never sends the field |

### 3. Reserved field: `precondition_policy?: "strict"`

v1 supports only `"strict"` (the default — reject on mismatch). Field exists in the zod input schema from day one. Future values (`"advisory"`, `"rebase"`) land as additive discriminator extensions — no breaking change.

### 4. `AccessPath.markdown_anchor` — reserved, not populated

ADR 0015 already reserves `AccessPath.selector` for sub-block ID-addressed selection. This ADR reserves a sibling field `AccessPath.markdown_anchor` for content-addressed selection shapes (e.g. Notion's `selection_with_ellipsis: "# Old Section...end"`). v1: the field exists in types, must be `null`, property test asserts null-only. Populating it lands as a separate ADR when a real capability needs it.

### 5. `reconcile_base_token` opacity lifted from implementation detail to contract

Red-team pass-3 F73 already rejected `state_vector_at_fetch` as client-unreconstructible and replaced it with the opaque server-issued token. This ADR declares the opacity **a non-negotiable contract**, not an implementation choice: future iterations MAY NOT make the token client-reproducible. The opacity is what lets the server change its reconciliation strategy (§6.6) without breaking deployed agents.

## Decision — what this ADR defers

A deliberate, enumerated list of what's *not* decided here. Each item has a revisit trigger so deferral is not drift.

| Deferred decision | Why defer | Revisit trigger |
|---|---|---|
| Full agent-ergonomic capability wrappers (`doc.read`, `doc.grep`, `block.edit(id, old, new)`, `doc.outline`) | Wrappers are thin; the ergonomic shape that wins can only be known from real traffic | First 100 real agent edit sessions across ≥3 distinct agents, OR Phase 5 hardening — whichever first. Follow-up ADR at that trigger. |
| Markdown block-ID anchor syntax (HTML comments vs `remark-directive {#id}` vs none) | Notion ships without anchors; `reconcile_base_token` + markdown-anchor selection may cover enough cases. Baking a syntax now risks being wrong in public | Same trigger as above. |
| Conflict-outcome policy beyond `"strict"` (`"rebase"`, `"advisory"`) | The right answer depends on whether agents batch-edit or stream-edit — we don't know | Telemetry shows a sustained rate of `StalePreconditionError` AND the distribution suggests retries would succeed via rebase |
| Per-block sub-selector shape (`AccessPath.selector` population) | Already reserved per ADR 0015; no capability needs it in v1 | When the first sub-block ACL or sub-block edit capability is designed |
| `block.replace_text(block_id, old, new)` as a first-class capability | Can lower to `doc.update` with precondition today; first-class only if traffic proves the ergonomic win | Same trigger as wrapper ADR |

## Deferred context — what the follow-up ADR inherits

Preserved so the trigger can fire cold: whoever picks up the agent-ergonomic wrapper ADR should read this section first.

### 1. Why Notion dropped optimistic concurrency (and whether we should copy them)

Notion's hosted MCP redesign (April 2026 [inside look](https://www.notion.com/blog/notions-hosted-mcp-server-an-inside-look)) **removed explicit version / ETag preconditions** in favor of content-addressed `selection_with_ellipsis: "# Old Section...end of section"`. The selector *is* the precondition — a missed match becomes a reject or no-op. Rationale (from their blog + MCP docs): agents reason better over semantic content than over opaque version numbers, and `selection_with_ellipsis` round-trips naturally through the markdown surface without requiring clients to track state.

**Read before re-deriving the question.** The temptation later is to think "we should add an ETag" — that path was tried and explicitly abandoned at Notion's scale. Our `expect_prior_content_hash` is a half-step: it preserves optimistic concurrency without forcing a version-number-addressing scheme, and it composes with content-addressed selection when we add that later. But the hash is not the *only* answer — a future wrapper capability may prefer ellipsis-style selection and skip the hash entirely.

**Known Notion pitfalls to avoid:** [#153](https://github.com/makenotion/notion-mcp-server/issues/153) and [#164](https://github.com/makenotion/notion-mcp-server/issues/164) show how discriminated-union command shapes + `additionalProperties: false` compose badly under strict JSON-Schema validators (Gemini CLI, Cursor). Contract tests must cover strict validators, not only the MCP SDK's permissive default.

### 2. Conflict-outcome options — the three production patterns

When a `StalePreconditionError` fires (or would fire), the caller needs a policy. Three patterns exist in production; each has a known failure mode:

| Policy | Implementation | Failure mode in production |
|---|---|---|
| **`strict` / reject** (our v1) | Fail fast; caller refetches and retries | Breaks streaming agent flows that can't refetch cheaply — retry storms at high concurrency. Safe default. |
| **`rebase` through CRDT** | Agent's `{old → new}` is re-located in current content; unmappable edits are dropped | Requires content-addressed anchors that survive CRDT operations. Matches ProseMirror's [central-authority rebasing pattern](https://prosemirror.net/docs/guide/). Works when agents edit small regions; degrades when agents rewrite whole blocks. |
| **3-way merge / last-writer-wins** | Both edits apply; recent write overrides older | [Outline #9521](https://github.com/outline/outline/issues/9521): REST write path and Y.js WebSocket path had split authority — the human's next save silently overwrote the API-originated edit. **Silent data loss**. Never do this unintentionally. |

The choice between `reject` and `rebase` depends on agent edit-size distribution, which we will not know until traffic accumulates. Defer.

### 3. Why Claude Code's `Edit(old_string, new_string)` works

Three load-bearing properties, citation trail: [Anthropic text editor docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/text-editor-tool), [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents), ["Replace Is All You Need"](https://medium.com/@rquintino/replace-is-all-you-need-the-surprisingly-simple-technique-behind-claudes-new-lightning-fast-b5ae18c3c113):

1. **Content-addressed targeting** — edits are located by *what the content is*, not by line / offset. Path-based edits break under formatting; content addressing degrades only when the content itself changes.
2. **Uniqueness-as-precondition** — "must match exactly once" is a one-shot disambiguation + optimistic concurrency check. A second concurrent writer who modifies the region invalidates the match, and the edit fails closed. Equivalent in spirit to an `If-Match` whose ETag is `sha256(old_string)` scoped to a region.
3. **Read-before-edit enforced at the tool boundary** — Claude Code refuses `Edit` without a prior `Read` in the same session. Prevents the "agent edits content it never inspected" class of bug.

**Known failure modes** ([tab bug #18050](https://github.com/anthropics/claude-code/issues/18050), [smart-quote bug #1986](https://github.com/anthropics/claude-code/issues/1986)) are instances of "byte-level exact match is too strict for content the model normalizes." For block-level Markdown this is far less brittle than for code.

If we ship `block.edit(block_id, old_content, new_content)` as a wrapper, we inherit all three properties — including property 3 (read-before-edit), which we must enforce in the wrapper because blocks are not files and the "same session" anchor doesn't transfer automatically.

### 4. Fidelity-tier × content-selection interaction

ADR 0013's three-tier fidelity contract interacts with content-addressed selection in a subtle way. A `lossless` tier block's markdown serialization may normalize whitespace, smart-quote, or Unicode form — producing byte-different output for semantically identical content. A `selection_with_ellipsis` or `expect_prior_content_hash` check that uses raw bytes will fail on round-tripped content even when the user sees "no change."

This is the scaled-up version of Claude Code's tab / smart-quote bugs. For editorzero's block-level case it matters more because:

- Markdown round-trips through `remark-parse` → mdast → `toMarkdown` apply normalization at both ends.
- An agent that fetched markdown, pretty-printed it locally, and submitted back would fail the hash check even without semantic changes.

**Mitigation for the wrapper ADR:** the hash should be computed over the *canonicalized* block JSON (the same canonicalization the audit layer uses), not over the serialized markdown. That way the hash is stable across markdown pretty-print roundtrips but still tight against real edits. Our v1 `expect_prior_content_hash` already takes this shape (canonical JSON, not raw markdown); the follow-up ADR inherits it.

### 5. Outline #9521 in plain English — the split-authority failure class

[outline/outline#9521](https://github.com/outline/outline/issues/9521) is the cautionary tale. Mechanism:

1. Agent hits REST API `PATCH /doc/{id}` → writes to the canonical doc store (Postgres).
2. Human is simultaneously editing via the browser, connected over WebSocket to the Y.js CRDT server.
3. Y.js CRDT server has its own in-memory state; it does not observe the REST-originated write.
4. Human's next save pushes a Y.js update that clobbers the REST write — because from Y.js's perspective, the agent's change never happened.
5. No error surfaces. The write simply disappears from the user's view.

**Why this matters for editorzero:** invariant 7 (single write path through `ctx.transact`) closes this on the *write* side — every mutation, REST-originated or otherwise, flows through Hocuspocus and produces a Y.js update. The *read→edit gap* is where it can still return: an agent reads a block at time T, thinks for 5 minutes, submits an update at T+5m — if a human edited the same block in between, our `expect_prior_content_hash` is the thing that detects the staleness and fails closed instead of silently clobbering.

**Guidance for future-us:** if someone proposes a "fast path" that skips `ctx.transact` for a particular capability (e.g. metadata-only block updates), they must independently argue past this failure class. Default is no. The existing metadata-only capability list (§ADR 0018) is enumerated explicitly for this reason.

### 6. Semantic vs opaque identifiers — why errors must echo `block_id` verbatim

Anthropic's [tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents) flags that opaque UUID identifiers **increase agent hallucination rates** — agents generate plausible-looking UUIDs when the real one is hard to find in context. Mitigations:

- Error messages must echo the agent-supplied identifier verbatim (our `StalePreconditionError.block_id` does this).
- Consider exposing semantic anchors (slug, heading path) alongside opaque IDs in future wrapper capabilities. A block referenced as `docs/project-charter#background` is harder for an agent to hallucinate than `01JK23MNOPQ4567RSTUV8WXYZ`.
- Our `DocId` / `BlockId` UUIDv7s stay as the storage-level identifiers (architecturally correct); wrappers may expose semantic sugar on top.

---

## Consequences

- **Agents get content-anchored editing ergonomics later without a breaking change.** Optional field on day one; future wrappers (`block.edit(old, new)`) lower cleanly to `doc.update { ops: [{ op: "update", block_id, post, expect_prior_content_hash: sha256(priorJson) }] }`.
- **Human UI work is unchanged.** BlockNote never sends the field; its omission is valid; concurrency is handled by Yjs as before.
- **Contract tests gain three new cells** on `doc.update`: (a) `StalePreconditionError` on hash mismatch; (b) success when field absent; (c) success when field matches. Contract test matrix (§5.5) includes these.
- **No dispatcher changes.** The precondition check lives inside the `doc.update` handler's `ctx.transact` closure; dispatcher's pipeline (parse → gate → handler → audit) is unchanged.
- **Audit effect unchanged.** `doc.update_batch` effect is post-state — preconditions are pre-check data, discarded after verification, not in the audit log.
- **Strict JSON-Schema validator coverage required.** Notion MCP schema bugs [#153](https://github.com/makenotion/notion-mcp-server/issues/153) / [#164](https://github.com/makenotion/notion-mcp-server/issues/164) document how discriminated unions + `additionalProperties: false` compose badly under strict validators. Contract tests validate `doc.update` input schema against the validators real agent clients use (Gemini CLI, Cursor, Codex) — not only the MCP SDK's permissive default.
- **Error-identifier round-trip.** `StalePreconditionError` surfaces MUST echo the agent-supplied `block_id` verbatim in error payloads. Anthropic's tool-design guidance ([Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)) flags that swallowing or renaming agent-supplied identifiers is a known hallucination-inducing pattern.

## Cross-references

- **Refines ADR 0013** (block model) — markdown block-ID anchor syntax remains an *open* question. The `preserveBlockIds` flag stays as the implementation knob; formal syntax choice deferred.
- **Refines ADR 0015** (permission enforcement) — adds `AccessPath.markdown_anchor` reservation beside the existing `AccessPath.selector`.
- **Refines ADR 0018** (unified write path) — precondition check fits inside the existing `ctx.transact` closure; no write-path shape change.
- **Binds architecture.md §6** (unified write path) + Appendix A (`doc.update` input schema) — input schema now includes the optional field; pipeline documents the precondition check placement.
- **Declares "Agent-ergonomic capability aliases ADR" deferred** with explicit trigger (see deferral table above). The other agent working through blocks / sync / `doc.update` reads this ADR before finalising the capability input schema.

## Revisit triggers

- **Block capabilities ship** without the `expect_prior_content_hash` field → blocking. Must land as part of the `doc.update` capability's first commit, not after.
- **First 100 real agent edit sessions** → open the full agent-ergonomic wrapper ADR. Measure: hash-mismatch rate, retry-success rate, wrapper-shape preferences observed in telemetry.
- **Phase 5 hardening** → reconsider `precondition_policy` values, sub-selector population, markdown anchor format with evidence in hand.
- **New MCP spec formalises optimistic concurrency** → align our field name if the community picks a convention.
- **`StalePreconditionError` rate >5% of agent writes** sustained → design the `"rebase"` policy variant; revisit conflict-outcome decision.
- **Notion or a comparable vendor publishes a stable content-addressed selection format** worth emulating → populate `AccessPath.markdown_anchor`.

## Sources

- Notion hosted MCP inside look: https://www.notion.com/blog/notions-hosted-mcp-server-an-inside-look
- Notion MCP supported tools: https://developers.notion.com/guides/mcp/mcp-supported-tools
- Notion `update-page` schema bug #153: https://github.com/makenotion/notion-mcp-server/issues/153
- Notion `update-page` schema bug #164: https://github.com/makenotion/notion-mcp-server/issues/164
- Linear GraphQL API: https://linear.app/developers/graphql
- Outline #9521 (split-authority silent-overwrite bug): https://github.com/outline/outline/issues/9521
- Outline storage format discussion: https://github.com/outline/outline/discussions/7396
- Anthropic — Writing effective tools for AI agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic — Text editor tool: https://docs.claude.com/en/docs/agents-and-tools/tool-use/text-editor-tool
- "Replace Is All You Need" (why content-anchored edits work): https://medium.com/@rquintino/replace-is-all-you-need-the-surprisingly-simple-technique-behind-claudes-new-lightning-fast-b5ae18c3c113
- Claude Code Edit tab bug #18050: https://github.com/anthropics/claude-code/issues/18050
- Claude Code Edit smart-quote bug #1986: https://github.com/anthropics/claude-code/issues/1986
- remark-directive `{#id}` syntax: https://github.com/remarkjs/remark-directive
- BlockSuite adapter / round-trip: https://blocksuite.io/guide/adapter.html
- ProseMirror collaborative editing (rebasing, central authority): https://prosemirror.net/docs/guide/
- HTTP `If-Match` / ETag / 412 (RFC 7232): https://datatracker.ietf.org/doc/html/rfc7232
