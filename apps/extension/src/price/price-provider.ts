/**
 * PRL market price provider.
 *
 * Fetches the PRL/USDT ticker from SafeTrade's public (Peatio/OpenDAX) API and
 * exposes a small {@link PriceProvider} seam so the source can be swapped or
 * disabled without touching the UI (mirrors the api/ ChainClient pattern).
 *
 * IMPORTANT: price is ADVISORY / DISPLAY-ONLY. It never touches signing or the
 * bigint Grain amount math. Display floats are fine here. We send no secrets and
 * no addresses to the price host — only an anonymous public GET. SafeTrade sits
 * behind Cloudflare; this client uses a plain browser fetch (the extension's
 * real-Chrome fingerprint is expected to pass where a server/curl is 403'd).
 *
 * Verified ticker shape (https://safetrade.com/api/v2/trade/public/tickers/prlusdt):
 *   { name:"PRL/USDT", last:"1.64", open:"1.28", high:"1.7", low:"1.21",
 *     avg_price:"1.49", price_change_percent:"+28.12%",
 *     volume:"1912949.46" (24h quote/USDT), amount:"1287203.14" (24h base/PRL) }
 * (volume / amount == avg_price, confirming `volume` is the USDT figure.)
 */

import { z } from "zod";

/** SafeTrade public API host (added to manifest host_permissions + CSP). */
export const PRICE_HOST = "https://safetrade.com";
/** PRL/USDT market id on SafeTrade. */
export const PRL_MARKET_ID = "prlusdt";
/** Toggle price display off (e.g. if the source becomes unavailable). */
export const PRICE_ENABLED = true;

const DEFAULT_TIMEOUT_MS = 12_000;

/** Parsed PRL market snapshot for display. */
export interface PrlTicker {
  /** Market label, e.g. "PRL/USDT". */
  market: string;
  /** Last trade price in USDT (≈ USD). */
  last: number;
  open: number;
  high: number;
  low: number;
  /** 24h change as the API's display string, e.g. "+28.12%". */
  changePercent: string;
  /** True when the 24h change is non-negative (for colour). */
  changePositive: boolean;
  /** 24h volume in USDT (quote) — the "$ in millions" figure. */
  volumeQuoteUsd: number;
  /** Epoch millis this snapshot was fetched. */
  ts: number;
  source: "safetrade";
}

export interface PriceProvider {
  /** Fetch the latest PRL ticker. Throws on network/shape failure. */
  getTicker(): Promise<PrlTicker>;
  /**
   * Fetch a recent price series (close prices) for a sparkline. No indexing —
   * served by the exchange's k-line endpoint. Throws on failure.
   */
  getCandles(opts?: { period?: number; limit?: number }): Promise<number[]>;
}

/** Flat SafeTrade ticker shape (values are decimal strings). Lenient. */
const tickerSchema = z
  .object({
    name: z.string().optional(),
    last: z.string(),
    open: z.string().optional(),
    high: z.string().optional(),
    low: z.string().optional(),
    avg_price: z.string().optional(),
    price_change_percent: z.string().optional(),
    volume: z.string().optional(),
    amount: z.string().optional(),
  })
  .passthrough();

/**
 * SafeTrade k-line: rows of [ts, open, high, low, close, volume]. Values may be
 * numbers or numeric strings; some deployments wrap the rows in `{ data: [...] }`.
 * Be tolerant of both so the chart works regardless.
 */
const klineRow = z.array(z.union([z.number(), z.string()]));
const klineSchema = z.union([
  z.array(klineRow),
  z.object({ data: z.array(klineRow) }),
]);

function num(s: string | undefined, fallback = 0): number {
  if (s === undefined) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

export class SafeTradePriceProvider implements PriceProvider {
  private readonly baseUrl: string;
  private readonly market: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Wall-clock source, injectable for deterministic tests. */
  private readonly now: () => number;

  constructor(opts: {
    baseUrl?: string;
    market?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {}) {
    const base = opts.baseUrl ?? PRICE_HOST;
    const url = new URL(base);
    if (url.protocol !== "https:") throw new Error("price host must be https");
    this.baseUrl = base.replace(/\/+$/, "");
    this.market = opts.market ?? PRL_MARKET_ID;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? (() => Date.now());
  }

  async getTicker(): Promise<PrlTicker> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/api/v2/trade/public/tickers/${this.market}`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "omit",
          mode: "cors",
          cache: "no-store",
          redirect: "error",
        },
      );
    } catch {
      throw new Error("price request failed");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`price request failed (${res.status})`);

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error("price response was not JSON");
    }
    const parsed = tickerSchema.safeParse(json);
    if (!parsed.success) throw new Error("price response shape unexpected");
    const t = parsed.data;

    const last = num(t.last);
    const open = num(t.open, last);
    const changePercent =
      t.price_change_percent ??
      (open > 0 ? `${(((last - open) / open) * 100).toFixed(2)}%` : "0%");
    const changePositive = !changePercent.trim().startsWith("-");

    return {
      market: t.name ?? "PRL/USDT",
      last,
      open,
      high: num(t.high, last),
      low: num(t.low, last),
      changePercent,
      changePositive,
      volumeQuoteUsd: num(t.volume),
      ts: this.now(),
      source: "safetrade",
    };
  }

  async getCandles(
    opts: { period?: number; limit?: number } = {},
  ): Promise<number[]> {
    const period = opts.period ?? 60; // minutes per candle (hourly)
    const limit = opts.limit ?? 24; // ~24h of points
    // Anchor the window to NOW. Without time_from/time_to, SafeTrade returns the
    // EARLIEST candles (oldest history) capped at `limit`, not the most recent.
    const now = Math.floor(this.now() / 1000);
    const timeFrom = now - period * 60 * limit;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/api/v2/trade/public/markets/${this.market}/k-line` +
          `?period=${period}&time_from=${timeFrom}&time_to=${now}&limit=${limit}`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "omit",
          mode: "cors",
          cache: "no-store",
          redirect: "error",
        },
      );
    } catch {
      throw new Error("candles request failed");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`candles request failed (${res.status})`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error("candles response was not JSON");
    }
    const parsed = klineSchema.safeParse(json);
    if (!parsed.success) throw new Error("candles response shape unexpected");
    const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
    // Peatio k-line rows: [ts, open, high, low, close, volume]; use close (idx 4).
    // slice(-limit): if the API ignores the window and returns more, keep the
    // most recent points (newest candles for the sparkline).
    return rows
      .map((r) => Number(r[4]))
      .filter((n) => Number.isFinite(n))
      .slice(-limit);
  }
}

let singleton: PriceProvider | null | undefined;

/** The configured price provider, or null if price display is disabled. */
export function getPriceProvider(): PriceProvider | null {
  if (singleton === undefined) {
    singleton = PRICE_ENABLED ? new SafeTradePriceProvider() : null;
  }
  return singleton;
}

// --- display formatting helpers (display-only) ---------------------------

/** Format a USDT(≈USD) price, widening decimals for sub-dollar prices. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(2)}`;
}

/** Format a USD volume compactly: 1912949 -> "$1.91M". */
export function formatVolumeUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
