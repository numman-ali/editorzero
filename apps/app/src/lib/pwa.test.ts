import { describe, expect, it } from "vitest";

import {
  IOS_HINT_DISMISSED_KEY,
  installAffordance,
  isInstalledDisplayMode,
  isInstallPromptEvent,
  isIosDevice,
  requestPersistentStorage,
} from "./pwa";

const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPADOS_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

describe("isInstallPromptEvent", () => {
  it("narrows an event carrying prompt() + userChoice", () => {
    const event = new Event("beforeinstallprompt");
    const control = Object.assign(event, {
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: "accepted" as const, platform: "web" }),
    });
    expect(isInstallPromptEvent(control)).toBe(true);
  });

  it("rejects a plain event (and one with a non-function prompt)", () => {
    expect(isInstallPromptEvent(new Event("click"))).toBe(false);
    const almost = Object.assign(new Event("beforeinstallprompt"), { prompt: "yes" });
    expect(isInstallPromptEvent(almost)).toBe(false);
  });
});

describe("isInstalledDisplayMode", () => {
  it("is installed when either probe fires, browser-tab when neither does", () => {
    expect(isInstalledDisplayMode({ standaloneMatch: true, navigatorStandalone: false })).toBe(
      true,
    );
    expect(isInstalledDisplayMode({ standaloneMatch: false, navigatorStandalone: true })).toBe(
      true,
    );
    expect(isInstalledDisplayMode({ standaloneMatch: false, navigatorStandalone: false })).toBe(
      false,
    );
  });
});

describe("isIosDevice", () => {
  it("detects iPhone UAs and iPadOS-masquerading-as-macOS via multi-touch", () => {
    expect(isIosDevice(IOS_SAFARI_UA, 5)).toBe(true);
    expect(isIosDevice(IPADOS_DESKTOP_UA, 5)).toBe(true);
  });

  it("does not flag desktop macOS (no touch) or Chromium desktop", () => {
    expect(isIosDevice(IPADOS_DESKTOP_UA, 0)).toBe(false);
    expect(isIosDevice(CHROME_UA, 0)).toBe(false);
  });
});

describe("installAffordance", () => {
  it("renders nothing once installed — on every path", () => {
    expect(
      installAffordance({
        promptCaptured: true,
        installed: true,
        ios: false,
        iosHintDismissed: false,
      }),
    ).toBe("none");
    expect(
      installAffordance({
        promptCaptured: false,
        installed: true,
        ios: true,
        iosHintDismissed: false,
      }),
    ).toBe("none");
  });

  it("prefers the captured Chromium prompt over the iOS hint", () => {
    expect(
      installAffordance({
        promptCaptured: true,
        installed: false,
        ios: true,
        iosHintDismissed: false,
      }),
    ).toBe("chromium-button");
  });

  it("shows the iOS hint only while undismissed, and nothing on plain browsers", () => {
    expect(
      installAffordance({
        promptCaptured: false,
        installed: false,
        ios: true,
        iosHintDismissed: false,
      }),
    ).toBe("ios-hint");
    expect(
      installAffordance({
        promptCaptured: false,
        installed: false,
        ios: true,
        iosHintDismissed: true,
      }),
    ).toBe("none");
    expect(
      installAffordance({
        promptCaptured: false,
        installed: false,
        ios: false,
        iosHintDismissed: false,
      }),
    ).toBe("none");
  });
});

describe("requestPersistentStorage", () => {
  it("returns the grant, false when unsupported, false on rejection", async () => {
    await expect(requestPersistentStorage({ persist: () => Promise.resolve(true) })).resolves.toBe(
      true,
    );
    await expect(requestPersistentStorage({})).resolves.toBe(false);
    await expect(
      requestPersistentStorage({ persist: () => Promise.reject(new Error("denied")) }),
    ).resolves.toBe(false);
  });
});

describe("IOS_HINT_DISMISSED_KEY", () => {
  it("stays on the ez- prefix shared by the app's persisted UI keys", () => {
    expect(IOS_HINT_DISMISSED_KEY.startsWith("ez-")).toBe(true);
  });
});
