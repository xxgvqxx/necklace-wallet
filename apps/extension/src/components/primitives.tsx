/**
 * Small shared UI primitives used across screens: Card, Header, PasswordField,
 * AddressDisplay (with copy), Spinner, and a few layout helpers. Kept together
 * to avoid a sprawl of one-line component files.
 */

import { useId, useState } from "react";
import { color, font, radius, space } from "./theme.js";

/** A surface card container. */
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: space.md,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Screen header with a title and optional back/right action. */
export function Header({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack?: () => void;
  right?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        minHeight: 28,
      }}
    >
      {onBack && (
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          style={{
            background: "transparent",
            border: "none",
            color: color.textDim,
            fontSize: 18,
            cursor: "pointer",
            padding: 0,
            lineHeight: 1,
          }}
        >
          ‹
        </button>
      )}
      <h1
        style={{
          fontSize: 16,
          fontWeight: 700,
          margin: 0,
          flex: 1,
          fontFamily: font.family,
          color: color.text,
        }}
      >
        {title}
      </h1>
      {right}
    </div>
  );
}

/** A password input with a show/hide toggle. The value is never logged. */
export function PasswordField({
  value,
  onChange,
  label = "Password",
  placeholder = "Enter your password",
  autoFocus = false,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}): React.JSX.Element {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
      <label
        htmlFor={id}
        style={{ fontSize: 12, color: color.textDim, fontFamily: font.family }}
      >
        {label}
      </label>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter) onEnter();
          }}
          style={{
            flex: 1,
            fontFamily: font.family,
            fontSize: 14,
            color: color.text,
            background: color.surfaceAlt,
            border: `1px solid ${color.border}`,
            borderRadius: radius.sm,
            padding: space.sm,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? "Hide password" : "Show password"}
          style={{
            marginLeft: space.sm,
            fontSize: 11,
            color: color.textDim,
            background: "transparent",
            border: `1px solid ${color.border}`,
            borderRadius: radius.sm,
            padding: `${space.xs}px ${space.sm}px`,
            cursor: "pointer",
          }}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

/** Renders an address in monospace with a copy-to-clipboard affordance. */
export function AddressDisplay({
  address,
  label,
}: {
  address: string;
  label?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; no-op (address is still selectable on screen).
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
      {label && (
        <span style={{ fontSize: 12, color: color.textDim }}>{label}</span>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          background: color.surfaceAlt,
          border: `1px solid ${color.border}`,
          borderRadius: radius.sm,
          padding: space.sm,
        }}
      >
        <span
          style={{
            fontFamily: font.mono,
            fontSize: 11,
            color: color.text,
            wordBreak: "break-all",
            flex: 1,
          }}
        >
          {address}
        </span>
        <button
          type="button"
          onClick={copy}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: copied ? color.success : color.accent,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** A simple centered loading state. */
export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        padding: space.xl,
        color: color.textDim,
        fontFamily: font.family,
        fontSize: 13,
      }}
    >
      <span style={{ fontSize: 20 }}>◌</span>
      {label && <span>{label}</span>}
    </div>
  );
}
