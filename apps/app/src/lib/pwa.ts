/**
 * Install-affordance policy for the PWA layer (ADR 0039 §1, "Install UX,
 * two paths"). Pure decision logic — the browser-event wiring (capturing
 * `beforeinstallprompt`, reading `matchMedia`) lives in
 * `components/pwa-prompt.tsx`; everything here takes plain values so the
 * policy is unit-testable to the coverage floor.
 *
 * The two paths, per the ADR:
 *   - **Chromium**: `beforeinstallprompt` is captured (`preventDefault`),
 *     and a custom Install button calls `prompt()` → `userChoice`.
 *   - **iOS**: the event NEVER fires (all iOS browsers are WebKit) — show
 *     a one-time "Add to Home Screen via Share" hint instead, gated on
 *     not-already-installed and not-previously-dismissed.
 */

/** localStorage key persisting the one-time iOS install hint dismissal. */
export const IOS_HINT_DISMISSED_KEY = "ez-pwa-ios-hint-dismissed";

/**
 * The subset of `BeforeInstallPromptEvent` the install flow uses. The
 * event type is Chromium-only and absent from lib.dom — this structural
 * interface plus the guard below stand in for it (no casting).
 */
export interface InstallPromptControl {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/** Structurally narrow a DOM event to the install-prompt control. */
export function isInstallPromptEvent(event: Event): event is Event & InstallPromptControl {
  return (
    "prompt" in event &&
    typeof event.prompt === "function" &&
    "userChoice" in event &&
    event.userChoice instanceof Promise
  );
}

/**
 * Installed-display detection (ADR 0039: gate the iOS hint on
 * not-installed). `standaloneMatch` = `matchMedia('(display-mode:
 * standalone)').matches`; `navigatorStandalone` = the WebKit-only
 * `navigator.standalone` flag, read structurally by the caller.
 */
export function isInstalledDisplayMode(probe: {
  standaloneMatch: boolean;
  navigatorStandalone: boolean;
}): boolean {
  return probe.standaloneMatch || probe.navigatorStandalone;
}

/**
 * iOS-device detection for the hint path. iPadOS 13+ masquerades as
 * macOS Safari (`Macintosh` UA) — the multi-touch probe is the
 * documented tell apart.
 */
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (/iphone|ipad|ipod/i.test(userAgent)) return true;
  return /macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

export type InstallAffordance = "chromium-button" | "ios-hint" | "none";

/**
 * Which install affordance (if any) to render. The captured-prompt
 * branch wins over the iOS branch by construction: `beforeinstallprompt`
 * firing proves a Chromium UA, where the Share-menu hint would be wrong.
 */
export function installAffordance(state: {
  promptCaptured: boolean;
  installed: boolean;
  ios: boolean;
  iosHintDismissed: boolean;
}): InstallAffordance {
  if (state.installed) return "none";
  if (state.promptCaptured) return "chromium-button";
  if (state.ios && !state.iosHintDismissed) return "ios-hint";
  return "none";
}

/**
 * Best-effort `navigator.storage.persist()` (ADR 0039 auth verdict —
 * iOS evicts origin storage LRU-under-pressure; persist() is a request,
 * not a guarantee, and a rejection is not an error worth surfacing).
 * Returns the grant outcome for the caller's optional state.
 */
export async function requestPersistentStorage(storage: {
  persist?: () => Promise<boolean>;
}): Promise<boolean> {
  if (typeof storage.persist !== "function") return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}
