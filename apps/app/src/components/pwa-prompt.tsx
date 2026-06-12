import { useRegisterSW } from "virtual:pwa-register/react";
import { useEffect, useState } from "react";

import {
  type InstallPromptControl,
  IOS_HINT_DISMISSED_KEY,
  installAffordance,
  isInstalledDisplayMode,
  isInstallPromptEvent,
  isIosDevice,
  requestPersistentStorage,
} from "../lib/pwa";

import "./pwa-prompt.css";

/**
 * The PWA chrome (ADR 0039 §1): service-worker registration, the
 * prompt-for-update toast, and the two install affordances. Mounted once
 * at the root route so it covers `/login` and the authed shell alike.
 *
 * - **Registration is explicit** (`injectRegister: false` in vite.config)
 *   — `useRegisterSW` on mount is the one registration site, so order is
 *   controlled and auditable.
 * - **Updates NEVER auto-apply.** `registerType: 'prompt'` parks the new
 *   SW in `waiting`; the toast's Reload button is the only path to
 *   SKIP_WAITING (a live editor must not be hot-swapped over unsynced
 *   state — ADR 0039 is explicit). "Later" just hides the toast; the
 *   waiting SW applies on the next full browser restart of the origin.
 * - **SW lifecycle stays out of the console** (zero-warnings gate;
 *   ADR 0019 keeps the SW outside OTel): a registration error surfaces
 *   as a dismissible status line instead of a log nobody owns.
 * - **Best-effort `navigator.storage.persist()`** after registration
 *   (iOS evicts LRU-under-pressure; the request costs nothing).
 *
 * Policy decisions (which affordance, iOS detection, display-mode) live
 * unit-tested in `lib/pwa.ts`; this component is browser glue + render,
 * e2e-covered by `packages/e2e/test/pwa.spec.ts`.
 */
export function PwaPrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW() {
      void requestPersistentStorage(navigator.storage);
    },
    onRegisterError() {
      setRegisterFailed(true);
    },
  });

  const [registerFailed, setRegisterFailed] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptControl | null>(null);
  const [iosHintDismissed, setIosHintDismissed] = useState(
    () => localStorage.getItem(IOS_HINT_DISMISSED_KEY) !== null,
  );

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      if (!isInstallPromptEvent(event)) return;
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  const affordance = installAffordance({
    promptCaptured: installPrompt !== null,
    installed: isInstalledDisplayMode({
      standaloneMatch: window.matchMedia("(display-mode: standalone)").matches,
      navigatorStandalone: "standalone" in navigator && navigator.standalone === true,
    }),
    ios: isIosDevice(navigator.userAgent, navigator.maxTouchPoints),
    iosHintDismissed,
  });

  async function handleInstall(): Promise<void> {
    if (installPrompt === null) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    // Either outcome consumes the captured event — Chromium will fire a
    // fresh `beforeinstallprompt` if install remains available later.
    setInstallPrompt(null);
  }

  function dismissIosHint(): void {
    localStorage.setItem(IOS_HINT_DISMISSED_KEY, "1");
    setIosHintDismissed(true);
  }

  const showStack = needRefresh || offlineReady || registerFailed || affordance !== "none";
  if (!showStack) return null;

  return (
    <div className="pwa-stack">
      {needRefresh ? (
        <div className="pwa-card" role="status">
          <span className="pwa-card-text">Update ready — reload to apply.</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void updateServiceWorker(true)}
          >
            Reload
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setNeedRefresh(false)}
          >
            Later
          </button>
        </div>
      ) : null}
      {offlineReady ? (
        <div className="pwa-card" role="status">
          <span className="pwa-card-text">
            Ready to work offline — pages you open keep loading without a connection.
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setOfflineReady(false)}
          >
            OK
          </button>
        </div>
      ) : null}
      {registerFailed ? (
        <div className="pwa-card" role="status">
          <span className="pwa-card-text">
            Offline support unavailable in this browser session.
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setRegisterFailed(false)}
          >
            OK
          </button>
        </div>
      ) : null}
      {affordance === "chromium-button" ? (
        <div className="pwa-card">
          <span className="pwa-card-text">Install editorzero as an app.</span>
          <button type="button" className="btn btn--sm" onClick={() => void handleInstall()}>
            Install
          </button>
        </div>
      ) : null}
      {affordance === "ios-hint" ? (
        <div className="pwa-card" role="status">
          <span className="pwa-card-text">
            Install on iOS: Share <span aria-hidden="true">→</span> Add to Home Screen.
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={dismissIosHint}>
            Got it
          </button>
        </div>
      ) : null}
    </div>
  );
}
