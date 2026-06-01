# ADR 0020 — Git-mirror export (opt-in) + optional S3-versioning archive

**Status:** Accepted (new)
**Date:** 2026-04-17
**Deciders:** @numman

> **Amended by [ADR 0040](0040-tenancy-ia-model.md) (2026-06-01).** The mirror is mirror-ALL and **ACL-unaware**; under Model B's per-doc ACL it would leak private / guest-only docs (and mirrored attachment URLs would 403 for guest-only docs). An explicit **export-scope decision** (mirror-by-publish-state vs Space-baseline vs mirror-all) **must land before the resolver gates reads.** Reserved-future, flagged here so it isn't forgotten. The event-rendered published-render path (architecture §5.4) is likewise ACL-unaware and must assert no guest-only leak before per-doc ACL enforcement.

## Context
The user initially proposed "Markdown in a versioned folder" as the storage model (retracted — see ADR 0013 v2). The underlying workflow desire is real: some users want a versioned-Markdown view of their docs for diff/PR/CI workflows; others want compliance snapshots. We decouple the workflow from the storage: CRDT stays the source of truth; projections land in external systems as **opt-in, one-way, downstream mirrors**.

Prior art (April 2026 refresh):
- **GitBook** is bidirectional but forces its block model to be a function of Markdown — we do not pay that tax.
- **Outline** has no first-party git export; the community asks for it.
- **Notion** ecosystem is a graveyard of one-shot exporters; pre-signed S3 attachment URLs expire; hourly batched.
- **Obsidian Git plugin** is per-user bidirectional; tracker documents every merge-conflict gotcha.
- **HedgeDoc** has had the request open since 2018; never shipped.
- **Docusaurus** is the canonical reader — expects Markdown-on-disk with gray-matter frontmatter.

Common shape across survivors: **cron/batch commits, bot author, skipped or LFS-held binaries, never bidirectional from day one.**

## Decision

**Two opt-in mirror sinks, both driven from the same projection pipeline:**

1. **Git mirror (primary)** — writes the per-workspace Markdown projection to an external git remote.
2. **S3-versioning archive (secondary)** — writes the same Markdown projection to an S3-compatible bucket with versioning enabled. For compliance snapshots, WORM, lifecycle rules. Not a replacement for git mirror.

Both sinks are configured per workspace, both respect the same debounce/batch cadence, both run under the ADR 0014 job queue.

## Git mirror architecture (v1)

### Projection pipeline
On every `doc_snapshots` write (ADR 0007 compaction), the job queue enqueues a `mirror.project_doc` job. The worker:
1. Loads the snapshot.
2. Renders per ADR 0013 v2: lossless/directive/opaque blocks → Markdown + frontmatter.
3. Writes `<workspace-mirror>/<collection-path>/<slug>.md` with:
   ```yaml
   ---
   editorzero:
     doc_id: <uuid>
     state_vector: <hex>
     last_exported: <iso8601>
   title: <doc title>
   ---
   ```
4. Triggers the commit/push flow.

### Library and dependencies
- **`simple-git`** shelling to the system `git` binary.
- Worker container includes `git` + `openssh` + certificate bundles.
- Thin adapter layer so `isomorphic-git` can be swapped in later for a browser-side dry-run preview.

**Rejected:** `nodegit` (native-dep hell, libgit2 auth segfaults on bad creds), `isomorphic-git` as primary (6× slower `git log` on 3k-commit repos, repacks aren't cached by default).

### Commit granularity — debounce + batch
Per-doc debounce: **2 min** of inactivity flushes a single commit per doc (one file changed per commit — clean diffs).
Cross-doc push batch: **60 s** window — accumulated commits push together.

This stays well under GitHub's secondary rate limits (80 content-generating requests/min, 500/hour) and matches real-world shipped patterns (Obsidian Git: 5-min windows; Notion exporters: hourly; GitBook: per-change-request).

### Attribution
Split author / committer:
- **Author:** the principal that triggered the change. Human → `"Alice <alice@example.com>"`. Agent → `"editorzero-agent <editorzero-agent[bot]@users.noreply.github.com>"` + `Co-authored-by: Alice <alice@example.com>` trailer if `acting_as` was set.
- **Committer:** always the mirror bot — `"editorzero-mirror <editorzero-mirror[bot]@users.noreply.github.com>"`.

Follows GitHub's Copilot Coding Agent convention and our AGENTS.md "agents are first-class; attribution survives token rotation" invariant.

### Attachments — v1 skip
Markdown references attachments by URL back to the editorzero instance (`https://<workspace>/attachments/<id>`). Binaries do not land in the git repo in v1 — keeps clones small, avoids repo bloat.

v2 roadmap: Git LFS with platform-owned S3 as the LFS backend, for users who want self-contained mirrors.

### Conflict handling — force-push to dedicated branch
- Mirror writes to `editorzero-mirror` branch, **never** to `main` / `master` / user-chosen default.
- On push conflict: `--force-with-lease` to the dedicated branch. Audit log captures before/after SHAs.
- Users who want to merge the mirror into their main development branch do so via a PR they own; the mirror never touches it.

This sidesteps the Obsidian-Git-style per-user merge-conflict failure class.

### Auth
Per workspace, one of:
- **GitHub App install (preferred).** 8h token, per-org rate limits, revocable via GitHub UI, no long-lived secrets on disk.
- **SSH deploy key.** For self-hosted Gitea/GitLab/Forgejo/bare remotes. Key generated by editorzero, uploaded to the remote by the user.
- **Personal Access Token (fallback).** Rotatable from the admin UI.

No OAuth-for-server flow (overkill for server-side workers). Credentials encrypted at rest; rotation via admin UI.

### Rate limits and backoff
Honor `Retry-After` headers and GitHub secondary-limit responses. Exponential backoff. Circuit-break on sustained rate-limit exhaustion; surface to workspace admin.

### Self-host configuration
Workspace admin configures at `/admin/mirrors/git`:
- Remote URL + auth.
- Branch name (default `editorzero-mirror`).
- Directory path layout (default `/<collection>/<slug>.md`).
- Debounce / batch windows (defaults above).
- Which collections to mirror (all / allowlist / denylist).

### Observability
Per OTel span: `mirror.project_doc`, `mirror.commit`, `mirror.push`. Metrics: commits/hour, push failures, rate-limit hits. Surfaced on `/admin/observability`.

### License interaction
AGPL-3.0 §13 triggers on **modified + network-accessed** code. An unmodified editorzero deployment producing Markdown outputs that land in a user's git repo does not cascade AGPL onto the mirror repo's contents — the mirror is downstream. Documented in our runbook.

## S3-versioning archive (secondary)

- Same projection pipeline.
- Writes to S3 / S3-compatible (MinIO, R2, Backblaze B2, GCS) with object versioning enabled.
- Object key: `<workspace>/<collection>/<doc_id>.md`.
- Same frontmatter shape.
- Lifecycle rules user-configured (hot → warm → cold tiers, compliance retention).
- Same debounce/batch windows.

Scoped as a **different user need** — compliance/WORM, not diff/PR. Lower-priority in v1 but cheap to ship once the projection pipeline is in place.

## Consequences
- Users who want versioned-Markdown workflows get them — as a mirror, not the storage.
- AGPL mirror-contents question answered; runbook note suffices.
- One projection pipeline feeds two sinks; orthogonal cost.
- Agent-edit attribution preserved in git commits; human-editor attribution ditto.
- No bidirectional complexity in v1. Deferred to v2+ after real-world feedback.

## Revisit triggers
- Demand for bidirectional editing (users want to PR back into the mirror). Deferred to v2+; requires CRDT↔text merge semantics.
- Demand for block-level per-section commits (split a doc across files by heading).
- Demand for a non-git / non-S3 sink (e.g., WebDAV, Confluence Cloud).
- Binary attachments in the mirror → Git LFS with platform-backed store (v2).
