/**
 * React hook that polls the PRL price while the popup is open, and loads a
 * recent price series for the sparkline.
 *
 * The ticker refreshes on open + every 30s while mounted + manual refresh. The
 * candle series (for the chart) changes slowly, so it loads on open + manual
 * refresh only (not on the 30s tick). Errors keep the last-good values rather
 * than blanking the UI. A null provider (price disabled) returns enabled:false.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getPriceProvider, type PrlTicker } from "./price-provider.js";

/** How often to refresh the ticker while the popup is open. */
export const PRICE_POLL_MS = 30_000;

export interface PrlPriceState {
  ticker: PrlTicker | null;
  /** Recent close prices for the sparkline (oldest -> newest). */
  candles: number[];
  loading: boolean;
  error: boolean;
  enabled: boolean;
  refresh: () => void;
}

export function usePrlPrice(): PrlPriceState {
  const providerRef = useRef(getPriceProvider());
  const enabled = providerRef.current !== null;
  const [ticker, setTicker] = useState<PrlTicker | null>(null);
  const [candles, setCandles] = useState<number[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  const refreshTicker = useCallback(() => {
    const provider = providerRef.current;
    if (!provider) return;
    void provider
      .getTicker()
      .then((t) => {
        if (!mounted.current) return;
        setTicker(t);
        setError(false);
      })
      .catch(() => {
        if (mounted.current) setError(true);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, []);

  const refreshCandles = useCallback(() => {
    const provider = providerRef.current;
    if (!provider) return;
    void provider
      .getCandles()
      .then((c) => {
        if (mounted.current) setCandles(c);
      })
      .catch(() => {
        // Chart is non-critical; keep the last series on failure.
      });
  }, []);

  const refresh = useCallback(() => {
    refreshTicker();
    refreshCandles();
  }, [refreshTicker, refreshCandles]);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      setLoading(false);
      return;
    }
    refresh();
    const id = setInterval(refreshTicker, PRICE_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [enabled, refresh, refreshTicker]);

  return { ticker, candles, loading, error, enabled, refresh };
}
