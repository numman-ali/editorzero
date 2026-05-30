## Appendix A — Capability matrix

Legend:
- **H** = callable by human (session / PAT). **A** = callable by agent (API key / agent-auth / MCP). **—** = unavailable.
- **Surfaces**: **API** / **CLI** / **MCP** / **UI** (Web UI SPA via typed RPC).

This matrix incorporates red-team fixes F12, F13, F15, F19, F22.

| Capability | Requires (scopes) | H | A | API | CLI | MCP | UI | Rate (per-min) | Audit effect kind |
|---|---|---|---|---|---|---|---|---|---|
| `capabilities.list` | — (filtered by principal — F22) | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `capabilities.describe` | — (filtered by principal — F22) | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `workspace.create` | admin (`humanOnly` in MVP; creating a whole workspace from within another workspace is a later capability) | H | — | ✓ | ✓ | — | ✓ | 10 | `workspace.create` |
| `workspace.update` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `workspace.update` |
| `workspace.get` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `workspace.list` | — | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `workspace.delete` | workspace:admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 5 | `workspace.soft_delete` |
| `workspace.restore` | workspace:admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 5 | `workspace.restore` |
| `workspace.purge` | workspace:admin + admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `workspace.purge` |
| `workspace.member_add` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `member.add` |
| `workspace.member_list` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `workspace.member_remove` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `member.remove` |
| `workspace.member_update_role` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `member.update_role` |
| `collection.create` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `collection.create` |
| `collection.update` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `collection.update` |
| `collection.move` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `collection.move` |
| `collection.delete` | doc:delete | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `collection.soft_delete` |
| `collection.restore` | doc:delete | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `collection.restore` |
| `collection.list` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `doc.create` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 300 | `doc.create` |
| `doc.get` | doc:read | H | A | ✓ | ✓ | ✓ (resource) | ✓ | 600 | read |
| `doc.list` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `doc.update` (F12: **canonical batch mutation**; replaces separate `block.insert/update/remove`. [ADR 0022](../adr/0022-agent-editing-constraints.md): per-op `expect_prior_content_hash?` on `update`/`move`/`remove`/`set_visibility` ops; `precondition_policy?: "strict"` reserved.) | doc:write, block:write | H | A | ✓ | ✓ | ✓ | ✓ | 600 (bucket `doc.write`) | `doc.update_batch` |
| `doc.update_from_markdown` (F66/F73: takes opaque `reconcile_base_token` from `doc.get`/`doc.get_markdown`) | doc:write, block:write | H | A | ✓ | ✓ | ✓ | — | 300 (bucket `doc.write`) | `doc.update_batch` (post-reconcile) |
| `doc.rename` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.rename` |
| `doc.move` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.move` |
| `doc.delete` | doc:delete | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.soft_delete` |
| `doc.restore` | doc:delete | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.restore` |
| `doc.purge` | doc:delete + admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 5 | `doc.purge` (full preimage) |
| `doc.publish` | doc:publish | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.publish` |
| `doc.unpublish` | doc:publish | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.unpublish` |
| `block.set_visibility` (kept distinct — metadata toggle, not CRDT op) | block:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 (bucket `doc.write`) | `block.set_visibility` |
| `version.create` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `version.create` |
| `version.list` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `version.get` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `version.restore` (F15: serialized per doc; emits pre-restore `version.create` of current state; broadcasts reload) | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `version.restore` (carries pre/post snapshot_seq) |
| `comment.create` | comment:write | H | A | ✓ | ✓ | ✓ | ✓ | 300 | `comment.create` |
| `comment.update` | comment:write | H | A | ✓ | ✓ | ✓ | ✓ | 300 | `comment.update` |
| `comment.resolve` | comment:resolve | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `comment.resolve` |
| `comment.delete` | comment:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `comment.soft_delete` |
| `comment.list` | comment:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `attachment.request_upload` (F57/F80: creates pending upload, returns signed PUT URL) | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `attachment.request_upload` |
| `attachment.confirm_upload` (F57/F80: verifies + moves blob + inserts row) | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `attachment.confirm_upload` |
| `attachment.get` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `attachment.delete` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `attachment.soft_delete` |
| `search.query` (F13: raised from 120) | search:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 (bucket `search.read`) | read (collapsible) |
| `search.suggest` (new — instant/typeahead, narrower scope) | search:read | H | A | ✓ | ✓ | ✓ | ✓ | 1800 (bucket `search.suggest`) | read (collapsible) |
| `permission.grant` | permission:grant | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `acl.grant` |
| `permission.revoke` | permission:revoke | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `acl.revoke` |
| `permission.list` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `audit.list` (paginated via composite `(before_created_at, before_id)` cursor; filters on subject pair, capability_id, outcome, time range) | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read (collapsible) |
| `audit.get` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read (collapsible) |
| `agent.create` | agent:create | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `agent.create` |
| `agent.rename` | agent:create | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `agent.rename` |
| `agent.revoke` | agent:revoke | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `agent.revoke` |
| `agent.list` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `token.create` (agent-tokens: agent:create; user PAT: `humanOnly`) | agent:create OR humanOnly | H | A (agent tokens only) | ✓ | ✓ | ✓ | ✓ | 10 | `token.create` |
| `token.revoke` (agent tokens: agent:revoke; own user PAT: `humanOnly`) | agent:revoke OR humanOnly-self | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `token.revoke` |
| `token.list` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `mirror.configure` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `mirror.configure` |
| `mirror.enable` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `mirror.enable` |
| `mirror.disable` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `mirror.disable` |
| `mirror.push_now` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | read (enqueues job) |
| `mirror.reset_state` (F58: clears `mirror_state` + enqueues full re-projection; no credential touch) | workspace:admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `mirror.reset_state` |
| `mirror.reset_auth` (F58: revokes the secret ref + disables the mirror; requires re-configure to re-enable) | workspace:admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `mirror.reset_auth` |
| `custom_domain.add` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `custom_domain.add` |
| `custom_domain.verify` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `custom_domain.verify` |
| `custom_domain.remove` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `custom_domain.remove` |
| **Webhooks** (F56) |  |  |  |  |  |  |  |  |  |
| `webhook.create` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `webhook.created` |
| `webhook.update` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `webhook.updated` |
| `webhook.list` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `webhook.get` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `webhook.delete` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `webhook.deleted` |
| `webhook.test_delivery` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `webhook.test_delivery` |
| `webhook.rotate_secret` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `webhook.rotated` |
| `webhook.refresh_dns` (F83: recomputes `resolved_ip` + `resolved_at`) | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `webhook.updated` |
| `admin.health` | admin (scoped pub subset is available to agents under `agentAllowed`) | H | A (public subset) | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `admin.metrics` | admin | H | A (read-only) | ✓ | ✓ | ✓ | ✓ | 120 | read |
| `admin.diagnose` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 10 | `admin.diagnose` (bundle id) |
| `admin.purge_runner` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | read (triggers cascade jobs) |
| **Admin jobs** (F19) |  |  |  |  |  |  |  |  |  |
| `admin.job_list` | admin | H | A (read-only) | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `admin.job_get` | admin | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `admin.job_requeue` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 60 | `admin.job_requeue` |
| `admin.job_cancel` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 60 | `admin.job_cancel` |
| `admin.queue_pause` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 10 | `admin.queue_pause` |
| `admin.queue_resume` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 10 | `admin.queue_resume` |
| **Admin search** (F19) |  |  |  |  |  |  |  |  |  |
| `admin.reindex_workspace` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `admin.reindex_workspace` |
| `admin.reembed_workspace` (F30) | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `admin.reembed_workspace` |
| **Admin sync** (F19) |  |  |  |  |  |  |  |  |  |
| `admin.evict_doc` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 30 | `admin.evict_doc` |
| `admin.unlock_doc` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 10 | `admin.unlock_doc` |
| **Admin secrets** (F19) |  |  |  |  |  |  |  |  |  |
| `admin.secret_rotate` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `admin.secret_rotate` (key_kind, not value) |

**Notes / gaps this matrix makes visible:**

- **F12 applied.** `block.insert`, `block.update`, `block.remove` are **removed as standalone capabilities**. Their intent is expressed as ops inside `doc.update`'s input. This collapses one rate-limit bucket (can't evade a 600/min `doc.write` budget by splitting to N `block.insert` calls), one audit model (`doc.update_batch` captures the full op list), and one mental model (agents batch or not, but don't pick between two APIs).
- **`block.set_visibility` remains distinct** — it's metadata, not a CRDT op; its handler writes `blocks.visibility` + increments `docs.visibility_version` (F5) synchronously inside the dispatcher tx without calling `ctx.transact`.
- **F13 applied.** `search.query` bucket raised to 600/min. `search.suggest` is a new lower-latency capability for typeahead with a generous 1800/min (30/s) budget on its own bucket. Both are read + collapsible (F2 rule: only reads may collapse).
- **`doc.update_from_markdown`** remains API/CLI/MCP only (not UI) — the web editor uses block ops directly. Kept for four-surface parity: agents often prefer Markdown.
- **`humanOnly`** rows (`workspace.delete`, `workspace.purge`, `workspace.create`, `doc.purge`, `admin.*` destructive, `mirror.reset_state`, `mirror.reset_auth`) filter out of MCP `tools/list` (F22); an agent never sees them. They remain on API + CLI for ops tooling.
- **`agentAllowed.extraScopes`** — a few rows grant agents access but with a higher bar (e.g., `admin.health`'s agent-readable subset requires `workspace:read` + `admin` scope tag; most operators never grant `admin` to an agent).
- **Capability IDs** double as registry-barrel keys and file paths (`capabilities/<group>/<name>.ts` → `<group>.<name>`). Adding a row here is adding a file — tools in the scaffolding generator (§Appendix C) do both in one command.

Every row has a corresponding kind in the `AuditEffect` union (§16.3) or is a `read` (no effect row). Exhaustiveness-checked at build.

---
