// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  DEFAULT_THEME,
  getStoredTheme,
  initTheme,
  isThemeName,
  NAMED_THEMES,
  setTheme,
  THEME_STORAGE_KEY,
} from "./theme";

/** In-memory `Storage` so tests don't depend on a shared global store. */
function memoryStorage(seed?: Record<string, string>): Storage {
  const map = new Map<string, string>(seed ? Object.entries(seed) : []);
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.get(key) ?? null;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

/** `Storage` whose access throws — models Safari private mode / disabled storage. */
function throwingStorage(): Storage {
  const fail = (): never => {
    throw new Error("storage unavailable");
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

/** Detached `<html>` element so injected-root tests don't touch the real document. */
function freshRoot(): HTMLElement {
  return document.createElement("html");
}

describe("isThemeName", () => {
  it("accepts the default sentinel and every named theme", () => {
    expect(isThemeName(DEFAULT_THEME)).toBe(true);
    for (const named of NAMED_THEMES) {
      expect(isThemeName(named)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isThemeName("neon")).toBe(false);
    expect(isThemeName(null)).toBe(false);
    expect(isThemeName(undefined)).toBe(false);
    expect(isThemeName(42)).toBe(false);
  });
});

describe("applyTheme", () => {
  it("sets data-theme for a named theme", () => {
    const root = freshRoot();
    applyTheme("dark", root);
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("removes data-theme for the default theme", () => {
    const root = freshRoot();
    root.setAttribute("data-theme", "dark");
    applyTheme(DEFAULT_THEME, root);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});

describe("getStoredTheme", () => {
  it("returns a persisted named theme", () => {
    expect(getStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "ultraviolet" }))).toBe(
      "ultraviolet",
    );
  });

  it("returns the persisted default sentinel", () => {
    expect(getStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: DEFAULT_THEME }))).toBe(
      DEFAULT_THEME,
    );
  });

  it("falls back to default for an invalid stored value", () => {
    expect(getStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "neon" }))).toBe(DEFAULT_THEME);
  });

  it("falls back to default when nothing is stored", () => {
    expect(getStoredTheme(memoryStorage())).toBe(DEFAULT_THEME);
  });

  it("falls back to default when storage throws", () => {
    expect(getStoredTheme(throwingStorage())).toBe(DEFAULT_THEME);
  });
});

describe("setTheme", () => {
  it("applies and persists a named theme", () => {
    const root = freshRoot();
    const storage = memoryStorage();
    setTheme("contrast", root, storage);
    expect(root.getAttribute("data-theme")).toBe("contrast");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("contrast");
  });

  it("round-trips through getStoredTheme", () => {
    const storage = memoryStorage();
    setTheme("dark", freshRoot(), storage);
    expect(getStoredTheme(storage)).toBe("dark");
  });

  it("persists the default sentinel and clears the attribute", () => {
    const root = freshRoot();
    root.setAttribute("data-theme", "dark");
    const storage = memoryStorage();
    setTheme(DEFAULT_THEME, root, storage);
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe(DEFAULT_THEME);
  });

  it("still applies the theme when persistence throws", () => {
    const root = freshRoot();
    expect(() => setTheme("dark", root, throwingStorage())).not.toThrow();
    expect(root.getAttribute("data-theme")).toBe("dark");
  });
});

describe("initTheme", () => {
  it("applies the persisted theme and returns it", () => {
    const root = freshRoot();
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "ultraviolet" });
    expect(initTheme(root, storage)).toBe("ultraviolet");
    expect(root.getAttribute("data-theme")).toBe("ultraviolet");
  });

  it("applies the default when nothing is persisted", () => {
    const root = freshRoot();
    root.setAttribute("data-theme", "dark");
    expect(initTheme(root, memoryStorage())).toBe(DEFAULT_THEME);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});

// Default-parameter wiring: calling with no injected root/storage must resolve
// `document.documentElement` + `localStorage` (the real globals under
// happy-dom). Exercises the default-value branches and proves the production
// call site (main.tsx `initTheme()`) is wired correctly.
describe("default document/localStorage wiring", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("setTheme then initTheme round-trips via the real globals", () => {
    setTheme("contrast");
    expect(document.documentElement.getAttribute("data-theme")).toBe("contrast");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("contrast");
    expect(initTheme()).toBe("contrast");
  });

  it("applyTheme + getStoredTheme use the real globals by default", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme(DEFAULT_THEME);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(getStoredTheme()).toBe(DEFAULT_THEME);
  });
});
