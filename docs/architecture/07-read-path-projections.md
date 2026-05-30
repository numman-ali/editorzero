## 7. Read path / projections

Reads never touch the write path. They project from the Y.Doc (or a cached projection):

| Projection | Freshness | Consumer |
|---|---|---|
| Block array JSON | real-time via Y.Doc | editor, `doc.get`, MCP resource |
| Rendered Markdown | computed on demand, cached per-snapshot | public render, mirror, MCP resource |
| Rendered HTML (published) | per-snapshot, cached | `(public)` route |
| `blocks` table rows | debounced (~250 ms post-onChange) | FTS, list queries, mirror |
| Embeddings | per-block async (ADR 0008) | semantic search |
| FTS index | per-block async | keyword search |
| Doc title | per-snapshot | listings |

Cache invalidation: every `onChange` emits a `doc.invalidated` event keyed by `{doc_id, snapshot_seq}`; consumers listen and invalidate their caches.
