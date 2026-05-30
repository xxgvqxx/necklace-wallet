/**
 * MarketStats — compact PRL market header: last price, 24h change, 24h volume,
 * with a manual refresh and a staleness/source caption.
 *
 * Presentational only; takes the {@link usePrlPrice} state. Renders nothing when
 * price display is disabled. Price is advisory (SafeTrade PRL/USDT mid via
 * `last`); it never affects amounts or signing.
 */

import { formatUsd, formatVolumeUsd } from "../price/price-provider.js";
import type { PrlPriceState } from "../price/usePrlPrice.js";
import { IconRefresh } from "./icons.js";
import { color, font, radius, space } from "./theme.js";

function formatAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function MarketStats({ state }: { state: PrlPriceState }): React.JSX.Element | null {
  if (!state.enabled) return null;

  const { ticker, loading, error, refresh } = state;

  if (loading && !ticker) {
    return (
      <div style={{ fontSize: 11, color: color.textFaint, textAlign: "center" }}>
        Loading PRL price…
      </div>
    );
  }
  if (!ticker) {
    return (
      <div
        style={{
          fontSize: 11,
          color: color.textFaint,
          textAlign: "center",
          display: "flex",
          gap: space.xs,
          justifyContent: "center",
        }}
      >
        Price unavailable
        <RefreshButton onClick={refresh} />
      </div>
    );
  }

  const changeColor = ticker.changePositive ? color.success : color.danger;

  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: `${space.sm}px ${space.md}px`,
        opacity: error ? 0.65 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: space.sm }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: color.text }}>PRL</span>
          <span style={{ fontSize: 16, fontWeight: 700, fontFamily: font.mono, color: color.text }}>
            {formatUsd(ticker.last)}
          </span>
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: changeColor }}>
          {ticker.changePercent}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: space.xs,
          fontSize: 10,
          color: color.textFaint,
        }}
      >
        <span>
          Vol {formatVolumeUsd(ticker.volumeQuoteUsd)} · SafeTrade ·{" "}
          {error ? "stale · " : ""}
          {formatAgo(ticker.ts)}
        </span>
        <RefreshButton onClick={refresh} />
      </div>
    </div>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label="Refresh price"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        color: color.textDim,
        cursor: "pointer",
        fontSize: 12,
        lineHeight: 1,
        padding: 0,
        display: "flex",
        alignItems: "center",
      }}
    >
      <IconRefresh size={12} />
    </button>
  );
}
