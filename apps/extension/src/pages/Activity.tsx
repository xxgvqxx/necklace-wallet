/**
 * Activity — transaction history for the wallet address. Display-only (never a
 * signing input). Each row shows direction, net value (PRL), confirmations, and
 * time. History comes from the untrusted indexer, so it is clearly the indexer's
 * view and cannot cause loss (threat-model §2).
 */

import { useCallback, useEffect, useState } from "react";
import { grainToPrl } from "@necklace/shared";
import type { ActivityTx, VaultState } from "../api/index.js";
import { ApiError, getApiClient, humanizeApiError } from "../api/index.js";
import { ErrorState, Header, Spinner } from "../components/index.js";
import { color, font, radius, space } from "../components/theme.js";
import type { Navigate } from "./types.js";

export interface ActivityProps {
  state: VaultState;
  navigate: Navigate;
}

function timeAgo(unixSeconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function Row({
  tx,
  onClick,
}: {
  tx: ActivityTx;
  onClick: () => void;
}): React.JSX.Element {
  const incoming = tx.direction === "received";
  const self = tx.direction === "self";
  const sign = incoming ? "+" : self ? "" : "";
  const tone = incoming ? color.success : self ? color.textDim : color.text;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        width: "100%",
        justifyContent: "space-between",
        alignItems: "center",
        textAlign: "left",
        padding: `${space.sm}px ${space.md}px`,
        background: "transparent",
        border: "none",
        borderBottom: `1px solid ${color.border}`,
        cursor: "pointer",
        fontFamily: font.family,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: color.text }}>
          {incoming ? "Received" : self ? "Sent to self" : "Sent"}
        </span>
        <span
          style={{
            fontSize: 10,
            color: color.textFaint,
            fontFamily: font.mono,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 160,
          }}
        >
          {tx.txid}
        </span>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 13, fontWeight: 600, fontFamily: font.mono, color: tone }}>
          {sign}
          {grainToPrl(tx.netValue)} PRL
        </div>
        <div style={{ fontSize: 10, color: color.textFaint }}>
          {tx.confirmations > 0 ? `${tx.confirmations} conf` : "pending"} •{" "}
          {timeAgo(tx.time)}
        </div>
      </div>
    </button>
  );
}

export function Activity({ state, navigate }: ActivityProps): React.JSX.Element {
  const [txs, setTxs] = useState<ActivityTx[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const address = state.address?.address;

  const load = useCallback(async () => {
    if (!address) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getApiClient().txs(address, { limit: 25 });
      setTxs(res.txs);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError("UNKNOWN", String(err)));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title="Activity" onBack={() => navigate({ name: "home" })} />

      {loading ? (
        <Spinner label="Loading activity…" />
      ) : error ? (
        <ErrorState
          kind={error.kind === "NODE_DOWN" ? "backend-down" : "generic"}
          message={humanizeApiError(error)}
          onRetry={() => void load()}
        />
      ) : txs && txs.length > 0 ? (
        <div
          style={{
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            overflow: "hidden",
          }}
        >
          {txs.map((tx) => (
            <Row
              key={tx.txid}
              tx={tx}
              onClick={() => navigate({ name: "txdetail", txid: tx.txid })}
            />
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: color.textDim, textAlign: "center", padding: space.lg }}>
          No transactions yet.
        </p>
      )}
    </div>
  );
}
