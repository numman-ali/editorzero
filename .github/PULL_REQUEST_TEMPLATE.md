<!--
Thanks for contributing to editorzero.

Before submitting, confirm:
-   Commits are signed off (`git commit -s`) — DCO is required (see CONTRIBUTING.md).
-   You've referenced the ADR(s) this PR implements.
-   The verification stack is green locally (types, lint, unit, property, integration, contract, e2e, smoke, observability).
-->

## Summary

<!-- What does this PR do? One or two sentences. -->

## ADR references

<!-- Link the ADR(s) this PR implements, e.g. [ADR 0006](../blob/main/docs/adr/0006-realtime-transport.md). -->

## Verification

- [ ] Types clean (`tsc --noEmit`)
- [ ] Lint + format clean
- [ ] Unit tests pass
- [ ] Property tests pass (if applicable — CRDT, Markdown round-trip, permission, soft-delete)
- [ ] Integration tests pass (SQLite AND Postgres conformance where applicable)
- [ ] Contract tests pass (API/CLI/MCP parity)
- [ ] E2E tests pass (including `@axe-core/playwright` for WCAG 2.1 AA)
- [ ] Smoke deploy green
- [ ] Observability check — traces export, no unexpected error spans

## Notes for reviewers

<!-- Anything a reviewer should know: trade-offs, deferred work, surprising-but-correct choices. -->

---

By opening this PR I confirm that all commits are signed off per the [Developer Certificate of Origin](https://developercertificate.org/) and my contribution is offered under AGPL-3.0-only.
