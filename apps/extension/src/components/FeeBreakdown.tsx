/**
 * FeeBreakdown — the transparent, itemised cost summary shown before signing.
 *
 * This component is the enforcement point for the fee-policy transparency rules
 * (fee-policy §1, §3, §6):
 *   - The flat Necklace fee is ALWAYS its own labelled line, with its
 *     destination address visible. It is NEVER blended into another number and
 *     there is no prop or flag that can hide it.
 *   - The network relay fee is shown as a SEPARATE line from the Necklace fee.
 *   - Change (returned to the user) is shown explicitly.
 *   - The total debited is the headline, with the components itemised beneath.
 *
 * All amounts are bigint Grain rendered via grainToPrl (no float math).
 */

import { grainToPrl, type Grain } from "@necklace/shared";
import { color, font, radius, space } from "./theme.js";

export interface FeeBreakdownProps {
  /** Amount to the recipient (Grain). */
  recipientValue: Grain;
  /** The flat Necklace fee (Grain). Always rendered. */
  necklaceFeeValue: Grain;
  /** The Necklace fee destination address (shown for transparency). */
  necklaceFeeAddress: string;
  /** Estimated network relay fee (Grain). */
  networkFee: Grain;
  /** Change returned to the user (Grain). */
  change?: Grain;
  /** True if change was below dust and rolled into the network fee. */
  changeDropped?: boolean;
}

function Row({
  label,
  sub,
  value,
  emphasis = false,
  highlight = false,
}: {
  label: string;
  sub?: string;
  value: string;
  emphasis?: boolean;
  highlight?: boolean;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: space.sm,
        padding: `${space.xs}px 0`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span
          style={{
            fontSize: emphasis ? 14 : 13,
            fontWeight: emphasis ? 700 : 500,
            color: highlight ? color.feeHighlight : color.text,
          }}
        >
          {label}
        </span>
        {sub && (
          <span
            style={{
              fontSize: 10,
              color: color.textFaint,
              fontFamily: font.mono,
              wordBreak: "break-all",
            }}
          >
            {sub}
          </span>
        )}
      </div>
      <span
        style={{
          fontSize: emphasis ? 14 : 13,
          fontWeight: emphasis ? 700 : 600,
          fontFamily: font.mono,
          color: highlight ? color.feeHighlight : color.text,
          whiteSpace: "nowrap",
        }}
      >
        {value} PRL
      </span>
    </div>
  );
}

export function FeeBreakdown({
  recipientValue,
  necklaceFeeValue,
  necklaceFeeAddress,
  networkFee,
  change,
  changeDropped = false,
}: FeeBreakdownProps): React.JSX.Element {
  // Total DEBITED = recipient + Necklace fee + network fee (change returns to user).
  const totalDebit = recipientValue + necklaceFeeValue + networkFee;

  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: `${space.sm}px ${space.md}px`,
      }}
    >
      <Row label="To recipient" value={grainToPrl(recipientValue)} />

      {/* The flat Necklace fee — its own line, address shown, never hidden. */}
      <Row
        label="Necklace fee (flat)"
        sub={necklaceFeeAddress}
        value={grainToPrl(necklaceFeeValue)}
        highlight
      />

      {/* Network relay fee — separate from the Necklace fee. */}
      <Row
        label={changeDropped ? "Network fee (incl. dust change)" : "Network fee"}
        value={grainToPrl(networkFee)}
      />

      {change !== undefined && change > 0n && (
        <Row label="Change (returns to you)" value={grainToPrl(change)} />
      )}

      <div
        style={{
          borderTop: `1px solid ${color.border}`,
          marginTop: space.xs,
          paddingTop: space.xs,
        }}
      >
        <Row label="Total debited" value={grainToPrl(totalDebit)} emphasis />
      </div>
    </div>
  );
}
