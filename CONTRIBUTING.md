# Contributing to editorzero

Thanks for your interest in editorzero — an open-source, self-hostable AI-native documentation platform where humans and AI agents are peer co-editors.

## Project status
editorzero is in **Phase 3 (verification harness + feature slices)**. 24 capabilities have shipped end-to-end across `doc.*`, `collection.*`, `workspace.*`, and `audit.*`, reachable today via the API, CLI, and MCP adapters (the Web UI surface is being designed). Architectural Decision Records (0001–0026) live in [`docs/adr/`](docs/adr/); the rolling work state is in [`docs/continuation.md`](docs/continuation.md); the Phase 0 brief is at [`docs/brief.md`](docs/brief.md). High-value contributions right now: ADR reviews, threat-model red-teaming, and prior-art pointers — the codebase is solo-author + agent while the architecture settles.

## Developer Certificate of Origin (DCO)

editorzero uses the **Developer Certificate of Origin 1.1** (https://developercertificate.org/) instead of a Contributor License Agreement. Every commit must be signed off.

Sign off by adding a line to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The easiest way is `git commit -s` (or configure `git config format.signoff true` locally). The email must match your GitHub-verified email.

DCO sign-off means you attest that:

1. The contribution was created in whole or in part by you, and you have the right to submit it under the open source license indicated in the file; **or**
2. The contribution is based upon previous work that is covered under an appropriate open source license and you have the right to submit it under that same license; **or**
3. The contribution was provided directly to you by someone who certified (1), (2), or (3), and you have not modified it.

You also understand that the project and contribution are public, and that a record of the contribution (including all personal information you submit with it) is maintained indefinitely and may be redistributed.

Commits without DCO sign-off don't land — the pre-commit gate enforces `Signed-off-by`. (Once the PR flow opens to external contributors, the same rule applies: unsigned PRs are asked to amend and re-push.)

## Workflow

The project is **solo-author + agent** today, so the current flow is **direct-push-to-`main`** (no PRs; a bad commit is fix-forward; `main` is never force-pushed). The PR-based steps below apply once multiple external humans contribute.

1. **Propose before you build.** Non-trivial changes begin with an ADR in `docs/adr/`. The ADR template is in [`docs/adr/README.md`](docs/adr/README.md). Small bug fixes do not need an ADR; feature work does.
2. **Verification stack.** Every change passes, in order: types → lint → unit → property → integration → contract → e2e → smoke deploy → observability check, locally via pre-commit / pre-push hooks. See [`AGENTS.md`](AGENTS.md) for the full list. "I'll fix it in the next commit" is not acceptable — the hook doesn't let it land. One-time machine setup for the pre-push e2e lane: `pnpm -C packages/e2e exec playwright install chromium` (the Web UI suite boots the real trunk + Vite and drives Chromium); the CLI e2e additionally needs [bun](https://bun.sh) on `PATH`, and the Postgres-backed suites need Docker running (`EDITORZERO_SKIP_POSTGRES_TESTS=1` to bypass when working Docker-less).
3. **Commits are terse and imperative.** Context, decision, consequence. No filler.
4. **Reference the ADRs you implement** in the commit body, with test evidence.

*External contributors:* once the PR flow opens up, branch per slice (`slice/NNNN-short-slug`), and PRs carry the same verification + DCO requirements.

## Reporting bugs

Use GitHub Issues. Include: platform, version, reproducer, expected vs. actual behavior, and logs if relevant. For security issues, see [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Licensing

editorzero is licensed under **AGPL-3.0-only** ([`LICENSE`](LICENSE)). By contributing, you agree your contribution is offered under the same license. The DCO confirms you have the right to do so; we do not require a separate CLA.

## Agents welcome

editorzero treats AI agents as first-class principals. AI-assisted contributions are welcome under the same DCO terms — the human committing must sign off, taking responsibility for the submission. Use `Co-Authored-By:` trailers to credit AI collaborators (e.g., `Co-Authored-By: Claude <noreply@anthropic.com>`).
