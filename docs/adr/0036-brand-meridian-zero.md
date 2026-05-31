# ADR 0036 — Brand & visual identity: Meridian Zero

**Status:** Accepted (new, 2026-05-31)
**Date:** 2026-05-31
**Deciders:** @numman (selected Meridian Zero from a 12-design exploration — *"I love it — that's the one"*); Claude Opus 4.8 (exploration + token system, delegated per AGENTS.md)

## Context

The Web UI shell (task #13) needs a coherent visual identity *before* it is built, so every surface — dashboard, editor, reader, admin — renders from one vocabulary instead of accreting ad-hoc styling. Two constraints make brand load-bearing, not cosmetic:

1. **Humans and AI agents are peer co-editors** (invariant 4, ADR 0016). The UI must make principal-kind legible at a glance *everywhere presence appears* — carets, avatars, attribution, activity.
2. **editorzero is self-hostable and white-labelable.** The brand must be expressible as *data* (design tokens) a deployer can re-skin without forking, which is the theming contract ADR 0037 codifies.

A divergent-generate-then-curate Workflow produced **12 full-screen design explorations** (`wf_b3a17378-0fb` design; `wf_545b3708-b04` buildout), scored by a judge panel on density, legibility, agent-distinction, and themeability. Nomi selected **Meridian Zero**.

## Options considered

The twelve explorations — Phosphor (retro-computing), Konstrukt, Flightdeck, Aperture, Null-Field, Grid-Noir, Nullstate, Nulpunt-Mono-Acid, Scandi-Cool-Halling, Meridian, and two variants — each rendered as a full dense product surface (`docs/brand/v2/design-NN-*.html`). **Meridian Zero** won on three axes simultaneously: cold-Swiss / International-Typographic clarity at high information density; the cleanest human-vs-agent visual split; and the most token-friendly structure (every value already a CSS custom property), which is what makes ADR 0037's theming tractable.

## Decision

Adopt **Meridian Zero** — cold-Swiss / International-Typographic. The canonical token block is `docs/brand/v2/meridian-zero.css` (the SSOT); it is **AA-hardened** (WCAG 2.1 AA text + 1.4.11 non-text contrast, with a global `prefers-reduced-motion` guard).

- **Palette — cold throughout, no warmth in any channel.** Neutrals graphite (`--ink #0b0e14`) → cold paper-white (`--paper #f4f6f8`); steel mid-tones darkened to clear AA. **One** saturated cold accent: ultramarine (`--ultra #1f3cff`). Agents carry a **second** cold signal: electric cyan-teal (`--agent #00b6c4`). Functional greens/ambers are AA-tuned (`--ok #0a6e3e`), with explicit on-fill inks (`--on-accent`, `--on-agent`).
- **Type.** Space Grotesk (display) / Archivo (text) / JetBrains Mono (mono labels, tabular numerics) — all OFL-licensed.
- **Metrics.** 8px base unit; hairline rules (1px / 1.5px); **0px structural radius** (cold Swiss = no rounding anywhere structural); tabular numerics throughout.
- **Principal distinction is in the visual language.** Human = square ultramarine avatar; AI agent = **notched** cyan square (`clip-path`). A crosshair "zero / origin" mark is the repeated brand device.
- **Meridian Zero ships as the default *curated theme*** — one `:root` token set under ADR 0037's layered-token architecture, **not** hard-coded styling. The brand is therefore replaceable/re-skinnable by overriding tokens.

The dense screen gallery (`docs/brand/v2/screens/`, 14 surfaces, desktop + phone, live theme-switcher) is the visual reference for the shell slice.

## Consequences

- **One vocabulary across every surface.** The shell slice (task #13) builds against a fixed palette/type/metric system and the screen gallery, not a blank canvas.
- **Brand is data.** Dark mode, high-contrast, and per-deployment white-labeling are token swaps (ADR 0037), not forks. Meridian Zero is just the first curated theme.
- **Principal-kind legibility is structural** (square = human, notched = agent), satisfying the peer-principal invariant *visually*, everywhere presence renders.
- **AA is baked into the token contract**, not retrofitted per screen — a contrast regression is fixed at the token, once.

## Revisit triggers

- An `@axe-core/playwright` audit (ADR 0033) finds a token pairing below AA in the real React build → fix the **token**, not the screen.
- A deployer needs a brand the three-layer token model can't express (e.g. non-CSS-variable theming) → that is an ADR 0037 question, not this one.
- OFL fonts prove too heavy for the mobile/PWA performance budget (ADR 0039) → swap within the same metric system.

## Cross-references

- **Realised by** ADR 0037 (design-system + theming — Meridian Zero is its default curated theme; the token *architecture* lives there).
- **Expresses** ADR 0016 (principal model — the human/agent visual split). **Feeds** ADR 0039 (PWA manifest `theme_color` / `background_color` from brand tokens). **Audited under** ADR 0033 (a11y floor).
- **Research:** `wf_b3a17378-0fb` (design exploration), `wf_545b3708-b04` (buildout + a11y audit). **Assets:** `docs/brand/v2/meridian-zero.css` (SSOT), `themes.css` (curated alternates), `screens/` (14-surface gallery).
