/**
 * ErrorState — a consistent inline error banner for the failure cases the UI
 * must surface clearly: backend down, invalid address, insufficient funds,
 * wrong password, and generic failures.
 *
 * All text is rendered as inert React text nodes (never HTML / never eval'd),
 * so even an attacker-controlled API `message` is safe to display (threat-model
 * §2). No secrets are ever passed here.
 */

import { color, font, radius, space } from "./theme.js";

export type ErrorKind =
  | "backend-down"
  | "invalid-address"
  | "insufficient-funds"
  | "wrong-password"
  | "tx-rejected"
  | "generic";

export interface ErrorStateProps {
  kind?: ErrorKind;
  /** Title override; defaults to a per-kind title. */
  title?: string;
  /** Detail message (e.g. a node rejection reason). */
  message?: string;
  /** Optional retry action. */
  onRetry?: () => void;
  retryLabel?: string;
}

const DEFAULT_TITLE: Record<ErrorKind, string> = {
  "backend-down": "Can't reach the network",
  "invalid-address": "Invalid address",
  "insufficient-funds": "Insufficient funds",
  "wrong-password": "Incorrect password",
  "tx-rejected": "Transaction rejected",
  generic: "Something went wrong",
};

export function ErrorState({
  kind = "generic",
  title,
  message,
  onRetry,
  retryLabel = "Try again",
}: ErrorStateProps): React.JSX.Element {
  return (
    <div
      role="alert"
      style={{
        background: color.dangerSurface,
        border: `1px solid ${color.danger}`,
        borderRadius: radius.md,
        padding: space.md,
        display: "flex",
        flexDirection: "column",
        gap: space.xs,
        fontFamily: font.family,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700, color: color.danger }}>
        {title ?? DEFAULT_TITLE[kind]}
      </span>
      {message && (
        <span style={{ fontSize: 12, color: color.text, lineHeight: 1.4 }}>
          {message}
        </span>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            alignSelf: "flex-start",
            marginTop: space.xs,
            fontSize: 12,
            fontWeight: 600,
            color: color.text,
            background: "transparent",
            border: `1px solid ${color.danger}`,
            borderRadius: radius.sm,
            padding: `${space.xs}px ${space.sm}px`,
            cursor: "pointer",
          }}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
