/**
 * Theme mode (Monokai dark / Monokai light).
 *
 * The actual palettes live as CSS variables in index.html; switching is just
 * toggling `data-theme` on <html>. The choice persists in localStorage (a
 * popup-local, synchronous store) so `applyThemeMode(getThemeMode())` can run in
 * popup/main.tsx BEFORE React renders — no flash of the wrong theme.
 */

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "necklace.theme";

/** Read the saved theme; defaults to Monokai dark. */
export function getThemeMode(): ThemeMode {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

/** Apply a theme by setting `data-theme` on the document root. */
export function applyThemeMode(mode: ThemeMode): void {
  try {
    document.documentElement.setAttribute("data-theme", mode);
  } catch {
    // No document (non-DOM context); nothing to apply.
  }
}

/** Persist and apply a theme. */
export function setThemeMode(mode: ThemeMode): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage unavailable — still apply for this session.
  }
  applyThemeMode(mode);
}
