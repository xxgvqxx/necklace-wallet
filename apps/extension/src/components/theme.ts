/**
 * Design tokens for the popup UI. Inline-style values only (the manifest CSP
 * allows `style-src 'unsafe-inline'` for styles but forbids inline scripts and
 * all remote code). No external CSS, fonts, or images are loaded.
 */

/**
 * Theme tokens resolve to CSS variables defined in index.html, so the whole UI
 * re-themes by toggling `data-theme` on <html> (Monokai dark / Monokai light)
 * with zero per-component changes. See ../theme/theme-mode.ts.
 */
export const color = {
  bg: "var(--nk-bg)",
  surface: "var(--nk-surface)",
  surfaceAlt: "var(--nk-surface-alt)",
  border: "var(--nk-border)",
  text: "var(--nk-text)",
  textDim: "var(--nk-text-dim)",
  textFaint: "var(--nk-text-faint)",
  accent: "var(--nk-accent)",
  accentText: "var(--nk-accent-text)",
  danger: "var(--nk-danger)",
  dangerSurface: "var(--nk-danger-surface)",
  warn: "var(--nk-warn)",
  success: "var(--nk-success)",
  feeHighlight: "var(--nk-fee)",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

export const font = {
  family:
    "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** Common page wrapper style for popup screens (360px fixed width). */
export const pageStyle: React.CSSProperties = {
  fontFamily: font.family,
  background: color.bg,
  color: color.text,
  width: 360,
  minHeight: 480,
  margin: 0,
  padding: space.lg,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: space.md,
  // Rounded content card with a thin hairline border (replaces the old thick
  // white frame). The window backdrop is the dark theme bg, so the corners read
  // cleanly; the actual popup window shape is OS-drawn (macOS rounds it too).
  borderRadius: 16,
  border: `1px solid ${color.border}`,
};
