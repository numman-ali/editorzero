# ADR 0001 — License: AGPL-3.0 with DCO

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
OSS, self-hostable platform. Must (a) protect against hyperscaler re-hosting without contribution, (b) stay OSI-legitimate so Debian/Fedora main will ship it, (c) be compatible with both copyleft and permissive dependencies, (d) signal long-term community trust (not "we'll relicense when convenient").

## Options considered
- **AGPL-3.0** — OSI/FSF-approved; §13 network clause forces hosted forks to publish modifications. Elastic's Aug 2024 return to AGPL, Grafana's 2021 relicense, Nextcloud, Mattermost, Plausible all live here. Google/Apple forbid employee contributions; Microsoft discourages.
- **Apache-2.0** — biggest reach, zero hosting protection (MongoDB/Elastic pre-relicense failure mode).
- **ELv2 / SSPL / BSL / FSL** — source-available; non-OSI; community-legitimacy cost outweighs the protection gain, and BSL triggered live forks (OpenTofu).
- **Dual-license (AGPL + commercial) with a CLA preserving relicensing rights** — gives us future optionality, but CLAs of this shape are a persistent contributor-trust smell (MongoDB, HashiCorp, Elastic precedent) and depress external PR volume.
- **AGPL-3.0 + DCO (Developer Certificate of Origin)** — kernel/Docker/Kubernetes/GitLab model. No agreement; a per-commit `Signed-off-by:` line attesting the contributor has the right to submit under the project license. Does not reserve relicensing rights.

## Decision
**AGPL-3.0 with DCO sign-off required on every commit.**

We do not pre-emptively reserve the right to relicense. If a commercial SKU ever becomes necessary, we will seek contributor consent at that time. The trust signal — "we are committed to AGPL" — is more valuable to our community than preserving the rug-pull optionality.

## Consequences
- Real (if imperfect) protection against AWS/GCP/Azure re-hosting via §13.
- Compatible with Apache-2/MIT/BSD dependencies (flows one way).
- Google/Apple employees cannot contribute; accept this cost.
- DCO is a per-commit sign-off, not a separate agreement — trivially scriptable in `git commit -s`, easily enforced via a GitHub Action.
- If we ever want a dual-license commercial path, it will cost more work later (contributor outreach for permission); that friction is the point — it makes the commitment real.

## Revisit triggers
- A hyperscaler hosts the software and §13 requirements fail to trigger substantive contribution back, making the license change the wrong trade-off.
- A materially better copyleft license emerges (unlikely; the landscape consolidated 2023–2025).
