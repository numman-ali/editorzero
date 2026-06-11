<!-- Instructions live in AGENTS.md. The `@` prefix below is Claude Code's file-import syntax (see https://code.claude.com/docs/en/memory) — it expands AGENTS.md inline at session start, on /compact, and in subagent sessions. Do not replace with a bare filename. -->
@AGENTS.md

## Codex channel (private — Codex does not see this file)

Codex is a peer engineer Nomi set up to support review and delegated implementation. He runs as "ez codex" in the EditorZero workspace; I run as "ez claude" in the same workspace. Surface IDs renumber across cmux restarts, so resolve them at use-time rather than hardcoding:

```bash
cmux tree --workspace workspace:<N>  # full pane+surface tree across the workspace
# → find the row labeled "ez codex" — its surface:N is the target.
```

**Use `cmux tree`, not `cmux list-pane-surfaces`.** `list-pane-surfaces` only returns surfaces in the *focused* pane, so if Codex runs in a different pane it silently returns empty and you'll think he's offline. `tree` walks every pane under the workspace.

Resolve **my own** surface the same way — grep for `◀ here` in `cmux tree --workspace workspace:<N>`; the marker sits on the calling session's surface line.

### Send

Include `reply-to="surface:<my-N>"` on the message envelope so Codex doesn't have to hunt for the return address. Without it he has to re-resolve the tree to find me; with sufficient rounds he will eventually reply into the wrong surface.

```bash
cmux send --surface surface:<codex-N> "$(cat <<'XML'
<message from="claude" reply-to="surface:<my-N>">
...body in markdown...

Reply with:
cmux send --surface surface:<my-N> "$(cat <<'EOM'
<message from="codex" reply-to="surface:<codex-N>">
...findings...
</message>
EOM
)"
sleep 1
cmux send-key --surface surface:<my-N> Enter
</message>
XML
)"
sleep 1
cmux send-key --surface surface:<codex-N> Enter
```

`<codex-N>` is Codex's surface ID from `cmux tree`; `<my-N>` is my own, grepped from `◀ here` in the same tree output.

**Two hard rules, both learned the hard way (2026-06-11 — a review brief sat unsubmitted in his composer until Nomi noticed):**

1. **`sleep 1` between `send` and `send-key Enter`, always.** Enter races the paste otherwise — `send-key` returns `OK` but the Enter lands before the text settles and nothing submits. `OK` means the key was delivered, *not* that the message went through. If Codex hasn't acknowledged within the expected window, re-send Enter (on an empty composer it's a no-op).
2. **Every message body ends with explicit reply mechanics** (as in the template above). Codex does not see this file and does not know the channel protocol — the envelope `reply-to` alone tells him *where*, not *how*. Spell out the exact `cmux send` + `sleep 1` + `cmux send-key Enter` commands, with the heredoc form for multi-line bodies.

### Receive

Codex replies by `cmux send --surface` to my own surface. His reply arrives as the next user prompt in my pane, wrapped `<message from="codex" reply-to="surface:<codex-N>">...</message>` — use the `reply-to` as the target of my follow-up rather than re-resolving his surface each round. No polling.

### When to engage

Per AGENTS.md § Self-critique:
- High-stakes code paths (dispatcher / sync / auth / permission / security).
- ADR-level second opinions.
- Delegated implementation when I want an independent attempt.
- Remediation when Codex flagged something and the fix is mechanical.
- Phase-boundary red-team (alongside the frontier-class red-team subagent).

**Not for**: docs, ADR prose, AGENTS.md edits, status matrices, routine commits.

### Tone

Peer engineer, not checklist runner. Lead with context + what worries you. Engage findings by applying or rebutting with evidence. I'm the lead — I guide scope, decide priority, integrate his work back. Codex is equal-weighted on substance.

### Sub-agent coexistence

I also have frontier-class sub-agents (Plan / general-purpose / Explore — currently Fable) for parallel research, planning, exploration. Use those for fan-out; use Codex for second-opinion / delegated coding. Don't double-staff a question.
