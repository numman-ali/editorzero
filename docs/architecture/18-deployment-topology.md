## 18. Deployment topology

Per ADR 0012:

- **Single-node default:** `docker compose up`. One app container (Node 22 + Hono + Next + Hocuspocus + MCP + jobs), one Caddy sidecar, one SQLite volume. Installer URL serves `install.sh` pattern.
- **HA:** multi app replicas behind Caddy, Postgres, Redis, optional S3/MinIO for attachments + mirror archive. pg-boss per Postgres. Hocuspocus worker-nodes + single-manager.
- **CLI:** Bun-compiled static binaries, 5 target tuples (linux amd64/arm64, darwin amd64/arm64, windows amd64).
- **Backups (F84):**
  - **Postgres mode:** **continuous WAL archiving to S3 (primary)** — this is the RPO-bearing backup. Nightly `pg_dump` is a **secondary consistency backup** for operator-driven export (human-readable, single-file, convenient for `editorzero diagnose` / off-prem storage). `pg_dump` is NOT the DR primary.
  - **SQLite mode:** nightly `VACUUM INTO` + object-store copy.
  - Object store: snapshot of attachments bucket + Caddy cert storage (F59).
  - `doc_snapshots + doc_updates` implied by DB backup; `reconcile_bases` same (§3.18).

### 18.1 Disaster recovery (F34)

- **RPO (Recovery Point Objective):**
  - **Postgres mode:** 15 min via continuous WAL archiving to object storage (S3 / MinIO / compatible).
  - **SQLite mode:** 24 h via nightly `VACUUM INTO`.
- **RTO (Recovery Time Objective):**
  - 30 min to service on single-node restore.
  - 2 h for multi-node HA rebuild (Postgres PITR + node provisioning + cert reissue).
- **Restore procedure:**
  - **Postgres:** PITR to target timestamp, object-store restore to the same timestamp (attachments), Redis rebuild from empty (session registry + `custom_domains` cache + awareness state repopulate on first reconnect), Caddy certs restored from backup (see cert storage below).
  - **SQLite:** restore `*.sqlite` + `*-wal` files from backup; object-store restore to the same timestamp; Caddy certs restored from backup.
- **Caddy cert storage must be backed up (F59).** Back up and restore the **Caddy data directory** (single-node) or the Postgres cert-storage table (HA) alongside the DB + object store. Without this, restoring a workspace with N custom domains triggers N ACME re-issuances simultaneously — Let's Encrypt's **7-day renewal window** and per-tenant **5/day issuance cap** (ADR 0011) make this a real outage risk on workspaces with more than a handful of domains.
- **DR-mode cert cap bypass (F59).** An operator-bypassable flag `EDITORZERO_DR_MODE=true` can be set during restore. While active (24h): the ACME rate cap is raised; every cert re-issuance logs loudly at `warn` level with `reason="dr_mode"`; flag auto-clears after 24h. Cross-reference ADR 0011.
- **Backup coordination constraint (F84).** Database + object store **must be snapshotted within a 1-minute window** to avoid dangling `attachment_refs`. The coordination window is defined against the **WAL-archive snapshot point** (Postgres) or the `VACUUM INTO` completion point (SQLite), **not** the `pg_dump` completion point — `pg_dump` is the secondary consistency backup, not the primary. Backup script: `scripts/backup.sh` (to be created in Phase 3) executes `pg_basebackup` or WAL-archive reference + `VACUUM INTO` and object-store snapshot inside the window and verifies within a tolerance. Cross-reference ADR 0007.
- **Ephemera policy.** Redis holds session registry (F7 / §10.3), `custom_domain` proxy cache (§5.4), workspace awareness state. All rebuildable from Postgres within seconds of first reconnect; Redis loss does not require a restore.
- **`doc_updates` tombstone reaper floor.** The reaper (ADR 0007 compaction) must **not reap tombstoned rows older than `max(RPO, 24h)` minus the pin**. Pin at **72h** for safety — ensures a 15-min-RPO restore can still replay post-snapshot updates without gap.
- **Restore CLI.** Appendix A carries `editorzero restore --from=<backup>`; implementation is Phase 4 work.
