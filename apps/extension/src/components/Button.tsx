/**
 * Button — the single button primitive used across all screens. Variants cover
 * primary actions, secondary/ghost actions, and destructive actions. Supports a
 * busy state that disables interaction and shows a spinner glyph.
 */

import { color, font, radius, space } from "./theme.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Shows a busy indicator and disables the button. */
  busy?: boolean;
  /** Stretch to fill the container width. */
  fullWidth?: boolean;
}

function variantStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case "primary":
      return { background: color.accent, color: color.accentText, border: "none" };
    case "danger":
      return { background: color.danger, color: "#fff", border: "none" };
    case "secondary":
      return {
        background: color.surfaceAlt,
        color: color.text,
        border: `1px solid ${color.border}`,
      };
    case "ghost":
      return { background: "transparent", color: color.textDim, border: "none" };
  }
}

export function Button({
  variant = "primary",
  busy = false,
  fullWidth = false,
  disabled,
  children,
  style,
  ...rest
}: ButtonProps): React.JSX.Element {
  const isDisabled = disabled || busy;
  return (
    <button
      {...rest}
      disabled={isDisabled}
      style={{
        fontFamily: font.family,
        fontSize: 14,
        fontWeight: 600,
        padding: `${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        cursor: isDisabled ? "not-allowed" : "pointer",
        opacity: isDisabled ? 0.6 : 1,
        width: fullWidth ? "100%" : undefined,
        transition: "opacity 120ms ease",
        ...variantStyle(variant),
        ...style,
      }}
    >
      {busy ? "…" : children}
    </button>
  );
}
