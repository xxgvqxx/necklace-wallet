/**
 * TransactionDetail — drill-down for one transaction opened from Activity.
 *
 * Fetches the full transaction from the chain backend (Blockbook) and shows the
 * whole amount moved, your net effect, the network fee, status, and the senders
 * ("From") + receivers ("To") with your own addresses marked. Read-only; no key
 * material is involved and the backend is untrusted (display-only).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { grainToPrl, type Grain } from "@necklace/shared";
import type { TxDetail, TxIo, VaultState } from "../api/index.js";
import { ApiError, getApiClient, humanizeApiError } from "../api/index.js";
import { AddressDisplay, Card, ErrorState, Header, Spinner } from "../components/index.js";
import { color, font, space } from "../components/theme.js";
import type { Navigate } from "./types.js";

export interface TransactionDetailProps {
  txid: string;
  state: VaultState;
  navigate: Navigate;
}

function truncAddr(addr?: string): string {
  if (!addr) return "Coinbase (newly minted)";
  return addr.length > 24 ? `${addr.slice(0, 14)}…${addr.slice(-8)}` : addr;
}

function formatTime(unixSeconds: number): string {
  if (!unixSeconds) return "Pending";
  try {
    return new Date(unixSeconds * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

function IoList({
  title,
  items,
  mine,
}: {
  title: string;
  items: TxIo[];
  mine: Set<string>;
}): React.JSX.Element {
  return (
    <Card>
      <div style={{ fontSize: 11, color: color.textDim, marginBottom: space.sm }}>
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
        {items.map((io, i) => {
          const isMine = io.address ? mine.has(io.address) : false;
          return (
            <div
              key={`${i}-${io.address ?? "x"}`}
              style={{ display: "flex", justifyContent: "space-between", gap: space.sm }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontFamily: font.mono,
                  color: isMine ? color.accent : color.textDim,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {truncAddr(io.address)}
                {isMine ? " (You)" : ""}
              </span>
              <span
                style={{ fontSize: 11, fontFamily: font.mono, color: color.text, flexShrink: 0 }}
              >
                {grainToPrl(io.value)} PRL
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function TransactionDetail({
  txid,
  state,
  navigate,
}: TransactionDetailProps): React.JSX.Element {
  const [detail, setDetail] = useState<TxDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await getApiClient().tx(txid));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e)));
    } finally {
      setLoading(false);
    }
  }, [txid]);

  useEffect(() => {
    void load();
  }, [load]);

  const mine = useMemo(() => {
    const s = new Set<string>();
    if (state.address?.address) s.add(state.address.address);
    for (const a of state.accounts ?? []) if (a.address) s.add(a.address);
    return s;
  }, [state]);

  const net: Grain | null = useMemo(() => {
    if (!detail) return null;
    let v = 0n;
    for (const o of detail.outputs) if (o.address && mine.has(o.address)) v += o.value;
    for (const i of detail.inputs) if (i.address && mine.has(i.address)) v -= i.value;
    return v;
  }, [detail, mine]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title="Transaction" onBack={() => navigate({ name: "activity" })} />

      {loading ? (
        <Spinner label="Loading transaction…" />
      ) : error ? (
        <ErrorState
          kind={error.kind === "NODE_DOWN" ? "backend-down" : "generic"}
          message={humanizeApiError(error)}
          onRetry={() => void load()}
        />
      ) : detail ? (
        <>
          <Card>
            {net !== null && (
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  fontFamily: font.mono,
                  color: net > 0n ? color.success : net < 0n ? color.text : color.textDim,
                }}
              >
                {net > 0n ? "+" : ""}
                {grainToPrl(net)} PRL
              </div>
            )}
            <div style={{ fontSize: 11, color: color.textDim, marginTop: space.xs }}>
              {detail.confirmations > 0
                ? `${detail.confirmations} confirmations`
                : "Pending"}{" "}
              · {formatTime(detail.time)}
            </div>
            <div style={{ fontSize: 11, color: color.textFaint, marginTop: space.xs }}>
              Total moved: {grainToPrl(detail.valueOut)} PRL
              {detail.fee !== undefined
                ? ` · Network fee: ${grainToPrl(detail.fee)} PRL`
                : ""}
            </div>
          </Card>

          <IoList title="From" items={detail.inputs} mine={mine} />
          <IoList title="To" items={detail.outputs} mine={mine} />

          <AddressDisplay address={detail.txid} label="Transaction ID" />
        </>
      ) : null}
    </div>
  );
}
