<!-- Instructions live in AGENTS.md. The `@` prefix below is Claude Code's file-import syntax (see https://code.claude.com/docs/en/memory) — it expands AGENTS.md inline at session start, on /compact, and in subagent sessions. Do not replace with a bare filename. -->
@AGENTS.md

## Codex channel (private — Codex does not see this file)

Codex is a peer engineer Nomi set up to support review and delegated implementation. He runs as "ez codex" in `surface:126` (workspace:6). I'm "ez claude" in `surface:152`.

### Send

```bash
cmux send --surface surface:126 "$(cat <<'XML'
<message from="claude">
...body in markdown...
</message>
XML
)"
cmux send-key --surface surface:126 Enter
```

### Receive

Codex replies by `cmux send --surface surface:152`. His reply arrives as the next user prompt in my own pane, wrapped `<message from="codex">...</message>`. No polling.

### When to engage

Per AGENTS.md § Self-critique:
- High-stakes code paths (dispatcher / sync / auth / permission / security).
- ADR-level second opinions.
- Delegated implementation when I want an independent attempt.
- Remediation when Codex flagged something and the fix is mechanical.
- Phase-boundary red-team (alongside the Opus red-team subagent).

**Not for**: docs, ADR prose, AGENTS.md edits, status matrices, routine commits.

### Tone

Peer engineer, not checklist runner. Lead with context + what worries you. Engage findings by applying or rebutting with evidence. I'm the lead — I guide scope, decide priority, integrate his work back. Codex is equal-weighted on substance.

### Sub-agent coexistence

I also have Opus sub-agents (Plan / general-purpose / Explore) for parallel research, planning, exploration. Use those for fan-out; use Codex for second-opinion / delegated coding. Don't double-staff a question.
