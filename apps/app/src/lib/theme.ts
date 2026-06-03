/**
 * Theme runtime (ADR 0037). A theme is *only* a set of `:root` token
 * overrides selected by `html[data-theme="…"]` (see `styles/themes.css`).
 * The default — Meridian Zero, light — is the *absence* of the attribute,
 * so applying it removes `data-theme` rather than setting a value.
 *
 * The same selection runs twice: here (post-hydration, with persistence)
 * and as a tiny inline guard in `index.html` (pre-paint, to avoid a flash
 * of the default theme). Keep `THEME_STORAGE_KEY` and the accepted values
 * below in sync with that guard.
 */

/** localStorage key holding the persisted theme. Mirrored by the index.html guard. */
export const THEME_STORAGE_KEY = "ez-theme";

/** Named themes carried by `styles/themes.css` as `html[data-theme="…"]` blocks. */
export const NAMED_THEMES = ["dark", "contrast", "ultraviolet"] as const;

/** `"default"` is Meridian Zero (light) — the no-attribute base in `:root`. */
export const DEFAULT_THEME = "default";

export type NamedTheme = (typeof NAMED_THEMES)[number];
export type ThemeName = typeof DEFAULT_THEME | NamedTheme;

/** Narrow an unknown value (e.g. a `localStorage` string) to a `ThemeName`. */
export function isThemeName(value: unknown): value is ThemeName {
  if (typeof value !== "string") {
    return false;
  }
  if (value === DEFAULT_THEME) {
    return true;
  }
  return NAMED_THEMES.some((named) => named === value);
}

/**
 * Reflect `theme` onto `root`'s `data-theme` attribute. The default theme is
 * the *absence* of the attribute, so it is removed rather than set.
 */
export function applyTheme(theme: ThemeName, root: HTMLElement = document.documentElement): void {
  if (theme === DEFAULT_THEME) {
    root.removeAttribute("data-theme");
    return;
  }
  root.setAttribute("data-theme", theme);
}

/**
 * Read the persisted theme, falling back to the default for a missing,
 * invalid, or unreadable (private-mode) value.
 */
export function getStoredTheme(storage: Storage = localStorage): ThemeName {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    return isThemeName(stored) ? stored : DEFAULT_THEME;
  } catch {
    // Storage can throw (Safari private mode, disabled cookies). Treat an
    // unreadable store as "no preference" -> default theme.
    return DEFAULT_THEME;
  }
}

/** Apply `theme` and persist it. Application is never gated on storage success. */
export function setTheme(
  theme: ThemeName,
  root: HTMLElement = document.documentElement,
  storage: Storage = localStorage,
): void {
  applyTheme(theme, root);
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; a write failure (quota, private mode) must
    // not undo the theme that was already applied above.
  }
}

/** Apply the persisted theme on boot. Returns the resolved theme. */
export function initTheme(
  root: HTMLElement = document.documentElement,
  storage: Storage = localStorage,
): ThemeName {
  const theme = getStoredTheme(storage);
  applyTheme(theme, root);
  return theme;
}
