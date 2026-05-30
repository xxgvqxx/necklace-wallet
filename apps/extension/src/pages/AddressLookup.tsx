/**
 * AddressLookup — a read-only explorer: enter any Pearl address and see how much
 * PRL it holds (confirmed + pending), with an ≈ fiat value and 30s polling.
 *
 * Read-only and key-free: it only sends a public address to the chain backend
 * (Blockbook) and shows the returned balance. No vault, no signing, no secrets.
 * The address is validated LOCALLY against the active network before any call.
 */

import { useCallback, useEffect, useState } from "react";
import { grainToPrl, type Grain } from "@necklace/shared";
import { ACTIVE_NETWORK, ApiError, getApiClient, humanizeApiError } from "../api/index.js";
import { AddressField } from "../components/AddressField.js";
import { Button, ErrorState, Spinner } from "../components/index.js";
import { IconBack, IconRefresh } from "../components/icons.js";
import { color, font, radius, space } from "../components/theme.js";
import { formatUsd } from "../price/price-provider.js";
import { usePrlPrice } from "../price/usePrlPrice.js";
import type { Navigate } from "./types.js";

/** Re-poll the looked-up address this often while the screen is open. */
const LOOKUP_POLL_MS = 30_000;

interface LookupBalance {
  confirmed: Grain;
  unconfirmed: Grain;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

export function AddressLookup({ navigate }: { navigate: Navigate }): React.JSX.Element {
  const [input, setInput] = useState("");
  const [valid, setValid] = useState(false);
  /** The address currently being displayed + polled (set on "Look up"). */
  const [query, setQuery] = useState<string | null>(null);
  const [balance, setBalance] = useState<LookupBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const price = usePrlPrice();

  const runLookup = useCallback(async (addr: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getApiClient().balance(addr);
      setBalance({ confirmed: res.confirmed, unconfirmed: res.unconfirmed });
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError("UNKNOWN", String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!query) return;
    void runLookup(query);
    const id = setInterval(() => void runLookup(query), LOOKUP_POLL_MS);
    return () => clearInterval(id);
  }, [query, runLookup]);

  function submit(): void {
    if (!valid) return;
    setBalance(null);
    setError(null);
    setQuery(input.trim());
  }

  const confirmedPrl = balance ? grainToPrl(balance.confirmed) : null;
  const pending = balance && balance.unconfirmed !== 0n;
  const fiat =
    balance && price.ticker
      ? formatUsd(Number(grainToPrl(balance.confirmed)) * price.ticker.last)
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate({ name: "home" })}
          style={{
            background: "transparent",
            border: "none",
            color: color.textDim,
            fontSize: 18,
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <IconBack size={18} />
        </button>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: font.family }}>
          Address lookup
        </span>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{ display: "flex", flexDirection: "column", gap: space.sm }}
      >
        <AddressField
          value={input}
          network={ACTIVE_NETWORK}
          onChange={setInput}
          onValidityChange={(r) => setValid(r.valid)}
          label="Pearl address"
          placeholder="prl1…"
        />
        <Button type="submit" fullWidth disabled={!valid}>
          Look up
        </Button>
      </form>

      {query && (
        <div
          style={{
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.lg,
            padding: space.lg,
            display: "flex",
            flexDirection: "column",
            gap: space.sm,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontFamily: font.mono,
              color: color.textDim,
              wordBreak: "break-all",
            }}
          >
            {query}
          </div>

          {loading && !balance ? (
            <Spinner label="Looking up balance…" />
          ) : error ? (
            <ErrorState
              kind={error.kind === "NODE_DOWN" ? "backend-down" : "generic"}
              message={humanizeApiError(error)}
              onRetry={() => void runLookup(query)}
            />
          ) : (
            <>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  fontFamily: font.mono,
                  color: color.text,
                }}
              >
                {confirmedPrl ?? "0"}{" "}
                <span style={{ fontSize: 13, color: color.textDim }}>PRL</span>
              </div>
              {fiat && (
                <div style={{ fontSize: 12, color: color.textDim }}>≈ {fiat}</div>
              )}
              {pending && (
                <div style={{ fontSize: 11, color: color.warn }}>
                  {grainToPrl(balance!.unconfirmed)} PRL pending
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: 10,
                  color: color.textFaint,
                  marginTop: space.xs,
                }}
              >
                <span>{updatedAt ? `Updated ${ago(updatedAt)}` : ""}</span>
                <button
                  type="button"
                  aria-label="Refresh"
                  onClick={() => void runLookup(query)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: color.textDim,
                    cursor: "pointer",
                    fontSize: 12,
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <IconRefresh size={13} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
