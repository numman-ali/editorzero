## 19. Open questions (carried into Phase 3)

Phase 1 resolved 2 of 4 open questions. Two remain; neither blocks Phase 3.

1. **Commercial arm** (brief §Open). Default proposal: **OSS-only in v1.** AGPL-3.0 + DCO (ADR 0001) keeps the door open for a hosted tier later without a license change. Revisit after Phase 5 launch data (install rate, GitHub stars, pull).
2. **Agent offline-edit**. Default proposal: **always-online in v1.** MCP Streamable HTTP reconnect semantics (§15.4) cover transient disconnects; a true offline mode (agent edits locally, reconciles on re-sync) requires a replica Y.Doc on the agent side — not impossible given Yjs, but non-trivial product scope. Revisit if a real user shows up for it.

Both will appear in the Phase 3 continuation as "pending, no change."

---
