/**
 * Home — the balance dashboard. Shows the wallet's confirmed (and pending)
 * balance in PRL, the active network, and the primary Send / Receive actions.
 *
 * Balance is fetched from the indexer (untrusted): a wrong balance can
 * mislead but cannot cause loss (threat-model §2). The figure is clearly the
 * indexer's view, and the network is shown so the user knows which chain.
 */

import { useCallback, useEffect, useState } from "react";
import type { VaultState } from "../api/index.js";
import { ApiError, getApiClient, humanizeApiError } from "../api/index.js";
import { grainToPrl, type Grain } from "@necklace/shared";
import { Button, ErrorState, Spinner } from "../components/index.js";
import { MarketStats } from "../components/MarketStats.js";
import { IconGitHub, IconSearch, IconSettings, IconX } from "../components/icons.js";
import { Sparkline } from "../components/Sparkline.js";
import { color, font, radius, space } from "../components/theme.js";
import { usePrlPrice } from "../price/usePrlPrice.js";
import { formatUsd } from "../price/price-provider.js";
import type { Navigate } from "./types.js";

export interface HomeProps {
  state: VaultState;
  navigate: Navigate;
}

interface BalanceState {
  confirmed: Grain;
  unconfirmed: Grain;
}

export function Home({ state, navigate }: HomeProps): React.JSX.Element {
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const price = usePrlPrice();

  const address = state.address?.address;

  const refresh = useCallback(async () => {
    if (!address) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getApiClient().balance(address);
      setBalance({ confirmed: res.confirmed, unconfirmed: res.unconfirmed });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError("UNKNOWN", String(err)));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasPending = balance !== null && balance.unconfirmed !== 0n;

  // Account chip: the active account's label + a 2-char avatar. Tapping it opens
  // the account switcher.
  const activeAccount = state.accounts?.find((a) => a.id === state.activeAccountId);
  const accountLabel = activeAccount?.label ?? "Account 1";
  const avatarText = (accountLabel.replace(/\s+/g, "").slice(0, 2) || "A").toUpperCase();

  // Portfolio value = PRL holdings × price; 24h change from the ticker's open.
  const prlAmount = balance ? Number(grainToPrl(balance.confirmed)) : 0;
  const ticker = price.ticker;
  const usdValue = ticker ? prlAmount * ticker.last : null;
  const changeUsd = ticker ? prlAmount * (ticker.last - ticker.open) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.lg, flex: 1 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          aria-label="Switch account"
          onClick={() => navigate({ name: "accounts" })}
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.lg,
            padding: `${space.xs}px ${space.sm}px`,
            cursor: "pointer",
            minWidth: 0,
            maxWidth: 160,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 22,
              height: 22,
              flexShrink: 0,
              borderRadius: "50%",
              background: color.surfaceAlt,
              border: `1px solid ${color.border}`,
              color: color.text,
              fontSize: 10,
              fontWeight: 700,
              fontFamily: font.family,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {avatarText}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: font.family,
              color: color.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {accountLabel}
          </span>
          <span style={{ fontSize: 10, color: color.textDim }}>▾</span>
        </button>
        <div
          style={{
            display: "flex",
            gap: space.sm,
            alignItems: "center",
            flexShrink: 0,
            marginLeft: space.sm,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: color.textDim,
              background: color.surfaceAlt,
              border: `1px solid ${color.border}`,
              borderRadius: radius.sm,
              padding: `2px ${space.xs}px`,
              textTransform: "uppercase",
            }}
          >
            {state.network}
          </span>
          <button
            type="button"
            aria-label="Address lookup"
            onClick={() => navigate({ name: "lookup" })}
            style={{
              background: "transparent",
              border: "none",
              color: color.textDim,
              fontSize: 15,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
          >
            <IconSearch size={16} />
          </button>
          <button
            type="button"
            aria-label="Settings"
            onClick={() => navigate({ name: "settings" })}
            style={{
              background: "transparent",
              border: "none",
              color: color.textDim,
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </div>

      <div
        style={{
          position: "relative",
          overflow: "hidden",
          background: color.surface,
          border: `1px solid ${color.border}`,
          borderRadius: radius.lg,
          padding: space.xl,
          textAlign: "center",
        }}
      >
        {!loading && !error && usdValue !== null && ticker && price.candles.length >= 2 && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              top: "45%",
              opacity: 0.22,
              pointerEvents: "none",
            }}
          >
            <Sparkline
              values={price.candles}
              color={ticker.changePositive ? color.success : color.danger}
            />
          </div>
        )}
        <div style={{ position: "relative", zIndex: 1 }}>
          {loading ? (
            <Spinner label="Loading balance…" />
        ) : error ? (
          <ErrorState
            kind={error.kind === "NODE_DOWN" ? "backend-down" : "generic"}
            message={humanizeApiError(error)}
            onRetry={() => void refresh()}
          />
        ) : (
          <>
            <div style={{ fontSize: 11, color: color.textDim }}>
              {usdValue !== null ? "Portfolio value" : "Balance"}
            </div>
            {usdValue !== null && ticker ? (
              <>
                <div
                  style={{
                    fontSize: 34,
                    fontWeight: 700,
                    fontFamily: font.mono,
                    color: color.text,
                    marginTop: space.xs,
                  }}
                >
                  {formatUsd(usdValue)}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: space.sm,
                    marginTop: space.xs,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: ticker.changePositive ? color.success : color.danger,
                    }}
                  >
                    {ticker.changePositive ? "+" : "-"}
                    {formatUsd(Math.abs(changeUsd ?? 0))}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: color.accentText,
                      background: ticker.changePositive ? color.success : color.danger,
                      borderRadius: radius.sm,
                      padding: `1px ${space.sm}px`,
                    }}
                  >
                    {ticker.changePercent}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: color.textDim,
                    fontFamily: font.mono,
                    marginTop: space.sm,
                  }}
                >
                  {balance ? grainToPrl(balance.confirmed) : "0"} PRL
                </div>
              </>
            ) : (
              <div
                style={{
                  fontSize: 30,
                  fontWeight: 700,
                  fontFamily: font.mono,
                  color: color.text,
                  marginTop: space.xs,
                }}
              >
                {balance ? grainToPrl(balance.confirmed) : "0"}{" "}
                <span style={{ fontSize: 14, color: color.textDim }}>PRL</span>
              </div>
            )}
            {hasPending && (
              <div style={{ fontSize: 11, color: color.warn, marginTop: space.xs }}>
                {grainToPrl(balance!.unconfirmed)} PRL pending
              </div>
            )}
          </>
        )}
        </div>
      </div>

      <MarketStats state={price} />

      <div style={{ display: "flex", gap: space.sm }}>
        <Button
          fullWidth
          onClick={() => navigate({ name: "send" })}
          disabled={state.watchOnly}
        >
          Send
        </Button>
        <Button variant="secondary" fullWidth onClick={() => navigate({ name: "receive" })}>
          Receive
        </Button>
      </div>

      {state.watchOnly && (
        <span style={{ fontSize: 11, color: color.textFaint, textAlign: "center" }}>
          Watch-only wallet — sending is disabled.
        </span>
      )}

      <Button variant="ghost" fullWidth onClick={() => navigate({ name: "activity" })}>
        View activity
      </Button>

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <a
          href="https://x.com/gvq_xx"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GVQ_xx on X"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            color: color.textDim,
            textDecoration: "none",
            fontSize: 12,
            fontFamily: font.family,
          }}
        >
          <IconX size={13} />
          <span>GVQ_xx</span>
        </a>
        <a
          href="https://liquid.trade"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Perps on Liquid"
          style={{
            color: color.textDim,
            textDecoration: "none",
            fontSize: 12,
            fontFamily: font.family,
          }}
        >
          (perps on liquid!)
        </a>
        <a
          href="https://github.com/xxgvqxx/necklace-wallet"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Necklace on GitHub"
          style={{ display: "flex", alignItems: "center", color: color.textDim }}
        >
          <IconGitHub size={15} />
        </a>
      </div>
    </div>
  );
}
