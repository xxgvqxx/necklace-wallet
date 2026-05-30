/**
 * AddressField — a recipient-address input that validates LOCALLY (client-side
 * first) against the active network as the user types. It
 * shows the decoded HRP/witness state and a clear reason on failure so a
 * swapped or wrong-network destination is visible before any send (threat-model
 * §1: address shown decoded). It never calls the network to validate.
 */

import { useId } from "react";
import type { Network } from "@necklace/shared";
import { validateAddress, type AddressValidation } from "../tx/index.js";
import { color, font, radius, space } from "./theme.js";

export interface AddressFieldProps {
  value: string;
  network: Network;
  onChange: (value: string) => void;
  /** Called with the latest validation result on every change. */
  onValidityChange?: (result: AddressValidation) => void;
  label?: string;
  placeholder?: string;
  /** Hide the inline error (e.g. while the field is empty/untouched). */
  suppressError?: boolean;
}

export function AddressField({
  value,
  network,
  onChange,
  onValidityChange,
  label = "Recipient address",
  placeholder = "prl1…",
  suppressError = false,
}: AddressFieldProps): React.JSX.Element {
  const id = useId();
  const trimmed = value.trim();
  const result = validateAddress(value, network);
  const showError = !suppressError && trimmed.length > 0 && !result.valid;
  const showValid = trimmed.length > 0 && result.valid;

  function handleChange(next: string): void {
    onChange(next);
    onValidityChange?.(validateAddress(next, network));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
      <label
        htmlFor={id}
        style={{ fontSize: 12, color: color.textDim, fontFamily: font.family }}
      >
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        rows={2}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.target.value)}
        style={{
          fontFamily: font.mono,
          fontSize: 12,
          lineHeight: 1.4,
          color: color.text,
          background: color.surfaceAlt,
          border: `1px solid ${showError ? color.danger : color.border}`,
          borderRadius: radius.sm,
          padding: space.sm,
          resize: "none",
          wordBreak: "break-all",
          outline: "none",
        }}
      />
      {showError && (
        <span style={{ fontSize: 11, color: color.danger }}>
          {result.reason}
        </span>
      )}
      {showValid && (
        <span style={{ fontSize: 11, color: color.success }}>
          Valid Taproot address ({result.hrp})
        </span>
      )}
    </div>
  );
}
