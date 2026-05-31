# ADR 0037 — Design system & theming: Base UI shell + layered design tokens

**Status:** Accepted (new, 2026-05-31; retires the Mantine-via-BlockNote styling assumption carried from ADR 0005/0031)
**Date:** 2026-05-31
**Deciders:** @numman (custom design system *"not Mantine"*; theming as first-class — *"it'd make a massive difference"*; *"I love that we don't need shadcn"*); Claude Opus 4.8 (library determination + token architecture, delegated per AGENTS.md)

## Context

The Web UI shell (task #13) needs a **headless primitive layer** — menus, dialogs, popovers, tooltips, drawers, selects, etc. — to build the Meridian Zero surfaces (ADR 0036) without re-implementing accessibility, focus management, and keyboard semantics by hand. Three forces frame the decision:

1. **Nomi's brief.** A *custom* design system (explicitly not Mantine, not ShadCN), plus **first-class theming**: users customise the theme by overriding global CSS variables; ship a few curated themes *and* let people author their own by editing global CSS, **no rebuild**.
2. **Residual drift to retire.** ADR 0005 (Next.js) was superseded by 0027; the leftover "Mantine via BlockNote" styling assumption (carried in ADR 0031's Phase-1 bootstrap) must go now that the editor drops BlockNote entirely (ADR 0038). Mantine ships its own CSS-variable theme system that would *fight* a token cascade.
3. **Verification.** A research Workflow (`wf_734a602e-3d6`) adversarially verified every library claim against the live npm registry + official docs on 2026-05-31 (Verdict 0), catching three errors before this ADR locked (below).

## Options considered

### A. Base UI (`@base-ui/react`) — CHOSEN
Zero-CSS headless primitives (data-attributes + CSS variables only; prescribes no styling solution). *"From the creators of Radix, Material UI, and Floating UI"* (MIT, MUI/OpenCollective-funded). Stable `Drawer` since 1.3.0 (swipe + snap points). Built on `@floating-ui/react-dom`, so it shares the anchoring-engine family with the owned Tiptap editor (ADR 0038). Publishes a valid `base-ui.com/llms.txt` (HTTP 200) — a machine-readable component inventory (agent-buildability).

### B. Radix Primitives — REJECTED for *new* adoption
Now *"Maintained by @workos"* with materially slowed velocity on complex components post-acquisition. Framed honestly as a **momentum/velocity concern, not "unmaintained"** (`@radix-ui/react-slot` still ~131M weekly downloads; shadcn now offers Radix *or* Base UI). Adopting it new in 2026 is the worse forward bet.

### C. React Aria Components (1.18.0) — runner-up, RECORDED FALLBACK
Ships **native Tree + Table** (graduated out of `UNSTABLE_`), so adopting it would also collapse the gap-fill below into one vendor. Not adopted now, to avoid mixing two headless vendors for overlays — but recorded as the named fallback if Base UI's velocity stalls.

### D. ShadCN / Mantine — REJECTED
ShadCN is Radix-derived + copy-in components; Mantine ships its own CSS-variable theme system. Both compete with or shadow editorzero's token cascade — the opposite of what the theming brief wants.

## Decision

**Build the Web UI shell on Base UI as the headless primitive layer, styled 100% through editorzero's own design tokens (zero vendor CSS).**

- **Gap-fill (Base UI has no Tree / DataTable / command-palette):** `cmdk` (command palette) + `@tanstack/react-table` (headless audit-log / version-history grids) + a small **owned Tree** (collections hierarchy). **One-vendor-for-overlays rule:** Base UI owns every overlay/menu/dialog/popover/tooltip/drawer primitive; don't accidentally double-staff a primitive with RAC.

- **Layered design-token architecture (the theming spine), CSS custom properties:**
  1. **PRIMITIVE** — raw, theme-agnostic scale values (colour ramps, spacing / radius / elevation / type steps) as `:root` vars. No semantics; never consumed directly by components.
  2. **SEMANTIC** — intent-named tokens (`--ez-color-bg-surface`, `--ez-color-fg-default`, `--ez-color-accent`, `--ez-border-subtle`, `--ez-elevation-overlay`) that reference primitives via `var()`. **The only layer components read.**
  3. **COMPONENT** — per-component tokens (`--ez-button-bg`, `--ez-drawer-shadow`) referencing semantic tokens, giving local override points without leaking primitives.

- **Theming model = override `:root` globals.** A theme is a CSS block that re-points `var()` targets: primitives stay fixed, semantics (and optionally component tokens) get re-bound. **Curated themes** (Meridian Zero default = ADR 0036; Graphite Dark; High Contrast; Ultraviolet — see `docs/brand/v2/themes.css`) **and user-authored themes** are *"just CSS"* — no JS token runtime, no rebuild. Runtime switching = swap a `data-theme` attribute on `:root`. This model is **uniquely enabled by Base UI's zero-CSS posture**: there is no vendor stylesheet competing with or shadowing the cascade, so the token layers own 100% of the visual surface. The AA token contract + the global `prefers-reduced-motion` guard (ADR 0036) live at the token layer.

- **Pins** (verified live npm + docs 2026-05-31, `wf_734a602e-3d6` Verdict 0; corrections folded in):

  | Package | Pin | Note |
  |---|---|---|
  | `@base-ui/react` | `1.5.0` | Exact, **hyphenated scope**. Renamed from the now-deprecated `@base-ui-components/react` (frozen at `1.0.0-rc.0`); the new scope's version line begins at `1.0.0-rc.1`. **Avoid the underscore typosquat `@base_ui/react`** (a one-time lockfile grep guard). |
  | `date-fns` | `^4.0.0` | **MANDATORY `peerDependency` of `@base-ui/react@1.5.0`** (date/calendar components) — *install errors if absent.* New since v1.0.0. Pin exact in the lockfile (ADR 0035). |
  | `@date-fns/tz` | `^1.2.0` | **MANDATORY `peerDependency`** alongside `date-fns`. Same install-or-error condition. |
  | `cmdk` | `1.1.1` | Command palette (Base UI has none). |
  | `@tanstack/react-table` | `8.21.3` | Headless data grid. A `9.0.0-alpha` line exists — **do not pin alpha**. |
  | `react-aria-components` | `1.18.0` | **NOT installed** — recorded fallback only (native Tree + Table). |
  | `@floating-ui/react-dom` | `^2.1.8` | Base UI's positioning dependency (the v2 React-DOM adapter), pulled transitively, alongside `@floating-ui/utils@^0.2.11`. **Base UI does NOT depend on `@floating-ui/dom` directly.** |
  | `react`, `react-dom` | `19.2.6` | Matches ADR 0035; Base UI peer-supports React `^17 ‖ ^18 ‖ ^19`. |

- **Floating-UI convergence (corrected).** The shell (Base UI → `@floating-ui/react-dom@^2`) and the editor (Tiptap → `@floating-ui/dom@^1` directly, ADR 0038) **converge on one `@floating-ui/dom@1.7.6` at install via two different specifiers/adapters** — one anchoring engine, one set of viewport-keeping middleware (shift/flip/size + autoUpdate) across shell menus/popovers/drawers and editor bubble/slash menus. The ADR states the convergence honestly; it does *not* pretend both depend on the same specifier. **Critical limit:** Floating UI provides **no** virtual-keyboard handling and **no** safe-area handling — those stay hand-owned app code (ADR 0039).

## Consequences

- **The token layers own 100% of the visual surface.** Theming + white-labeling are pure-data (`:root` overrides); user themes need no build step. This is the structural pay-off of choosing a zero-CSS shell.
- **`date-fns@4` becomes an app-wide transitive dependency** via Base UI's calendar components (open question: standardise on it app-wide, or confine to calendar usage).
- **A net-new owned Tree** must be built and tested (WCAG 2.1 AA + keyboard tree-walk) — the accepted cost of one-vendor-for-overlays + not adopting RAC. Budget it at the collections-pane slice.
- **Base UI v1.x is young** (v1.0.0 Dec 2025) with a **~monthly minor cadence** (28–36-day gaps — *observed velocity, not a published SLA*), so expect more cooldown-gated bumps than a mature library (ADR 0035's 3-day cooldown).
- **Agent-buildability bias.** Base UI's `llms.txt` + token-as-data theming + schema-derived blocks/capabilities (ADR 0009/0033) all point toward a future *"generate the UI / a brand theme from a skill"* workflow — forward-looking rationale, not a v1 deliverable.
- **Retires the Mantine assumption.** Mantine survives only as long as the BlockNote bootstrap did and exits with it (ADR 0038).

## Revisit triggers

- **Base UI velocity stalls** or a needed primitive never lands → adopt the recorded **RAC** fallback (which also collapses `cmdk` + owned Tree + TanStack Table into one headless vendor).
- The **owned Tree** grows virtualization / drag-reorder / multi-select demands → re-weigh RAC's native Tree at the collections-pane slice.
- A **second consumer of dates** appears → decide whether `date-fns@4` is the app-wide date library or stays confined to Base UI.
- A deployer needs **non-CSS-variable theming** → revisit the token-as-CSS model.

## Cross-references

- **Realises** ADR 0036 (Meridian Zero = the default curated theme). **Pairs with** ADR 0038 (owned editor — Floating-UI convergence; Tiptap menus) and ADR 0039 (PWA — Base UI `Drawer` for mobile nav; the Floating-UI keyboard/safe-area gap is hand-owned).
- **Supply-chain:** ADR 0035's exact-pin + lockfile + pnpm-cooldown posture **extends to these pins**, including the mandatory `date-fns` / `@date-fns/tz` peer-deps.
- **Supersedes** the Mantine-via-BlockNote styling assumption in ADR 0005 / 0031. **Audited under** ADR 0033 (a11y).
- **Research:** `wf_734a602e-3d6` Verdict 0 (Base UI / shell stack, live npm 2026-05-31) + the design-system synthesis memo + cross-cutting theming architecture.
