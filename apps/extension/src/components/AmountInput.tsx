/**
 * AmountInput — PRL amount entry validated locally to Grain (8-decimal, no
 * floats). Shows the parsed/validation error inline and optionally a "Max"
 * affordance. The value is always handled as a decimal-PRL string in the UI and
 * converted to bigint Grain by the tx layer; this component never does float math.
 */

import { useId } from "react";
import { grainToPrl, type Grain } from "@necklace/shared";
import { validateAmount, type AmountValidation } from "../tx/index.js";
import { color, font, radius, space } from "./theme.js";

export interface AmountInputProps {
  value: string;
  onChange: (value: string) => void;
  onValidityChange?: (result: AmountValidation) => void;
  label?: string;
  /** Spendable balance in Grain; enables the Max button and an overspend hint. */
  available?: Grain;
  /** Called when the user taps Max (caller decides how to set the field). */
  onMax?: () => void;
  suppressError?: boolean;
}

export function AmountInput({
  value,
  onChange,
  onValidityChange,
  label = "Amount (PRL)",
  available,
  onMax,
  suppressError = false,
}: AmountInputProps): React.JSX.Element {
  const id = useId();
  const result = validateAmount(value);
  const showError = !suppressError && value.trim().length > 0 && !result.valid;
  const overspends =
    available !== undefined &&
    result.valid &&
    result.grain !== undefined &&
    result.grain > available;

  function handleChange(next: string): void {
    // Allow only digits and a single dot while typing.
    if (next !== "" && !/^\d*\.?\d*$/.test(next)) return;
    onChange(next);
    onValidityChange?.(validateAmount(next));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}
      >
        <label
          htmlFor={id}
          style={{ fontSize: 12, color: color.textDim, fontFamily: font.family }}
        >
          {label}
        </label>
        {available !== undefined && (
          <span style={{ fontSize: 11, color: color.textFaint }}>
            Balance: {grainToPrl(available)} PRL
          </span>
        )}
      </div>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input
          id={id}
          value={value}
          inputMode="decimal"
          placeholder="0.0"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => handleChange(e.target.value)}
          style={{
            flex: 1,
            fontFamily: font.mono,
            fontSize: 16,
            color: color.text,
            background: color.surfaceAlt,
            border: `1px solid ${showError || overspends ? color.danger : color.border}`,
            borderRadius: radius.sm,
            padding: space.sm,
            outline: "none",
          }}
        />
        {onMax && available !== undefined && (
          <button
            type="button"
            onClick={onMax}
            style={{
              marginLeft: space.sm,
              fontSize: 11,
              fontWeight: 600,
              color: color.accent,
              background: "transparent",
              border: `1px solid ${color.border}`,
              borderRadius: radius.sm,
              padding: `${space.xs}px ${space.sm}px`,
              cursor: "pointer",
            }}
          >
            Max
          </button>
        )}
      </div>
      {showError && (
        <span style={{ fontSize: 11, color: color.danger }}>{result.reason}</span>
      )}
      {!showError && overspends && (
        <span style={{ fontSize: 11, color: color.danger }}>
          Amount exceeds your spendable balance.
        </span>
      )}
    </div>
  );
}
