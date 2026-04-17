# Security policy

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities.

Instead, report privately via **GitHub Security Advisories** on this repository:

- Go to the **Security** tab → **Advisories** → **Report a vulnerability**.
- Include a reproducer, affected version, and any mitigations you're aware of.

If GitHub Security Advisories are not an option, email `numman.ali@gmail.com` with `[editorzero security]` in the subject line.

## Supported versions

editorzero is pre-release (Phase 1, architecture planning). There is no supported release line yet. Once v1.0 ships, the latest minor receives security fixes; older minors are supported for one year from their last release.

## Response expectations

- **Acknowledgement:** within 72 hours.
- **Initial triage:** within one week.
- **Fix timeline:** depends on severity. Critical issues prioritized; we will communicate a concrete target in the triage response.
- **Disclosure:** coordinated. We will not disclose a vulnerability publicly until a fix is available and downstream users have had a reasonable window to apply it.

## Scope

In-scope:
- The editorzero codebase in this repository.
- Its documented deployment modes (docker-compose, self-host).
- Official Docker images and release artifacts.

Out-of-scope:
- Vulnerabilities in upstream dependencies (report to the dependency directly; we track advisories separately).
- Deployments misconfigured beyond the defaults.
- Rate-limiting concerns on clearly non-authenticated endpoints (reported separately as normal bugs).

## Safe harbor

Good-faith security research following this policy will not be pursued legally. Please avoid data destruction, privacy violations, service degradation, and interaction with user accounts or data you do not own.
