/**
 * SafeTradePriceProvider tests — no network. The fake fetch returns the EXACT
 * shape the live PRL/USDT ticker returns; we assert the parse + the display
 * formatters.
 */

import { describe, it, expect } from "vitest";
import {
  SafeTradePriceProvider,
  formatUsd,
  formatVolumeUsd,
} from "./price-provider.js";

// Verbatim live response from /api/v2/trade/public/tickers/prlusdt.
const LIVE = {
  id: "prlusdt",
  name: "PRL/USDT",
  base_unit: "prl",
  quote_unit: "usdt",
  avg_price: "1.49",
  high: "1.7",
  last: "1.64",
  low: "1.21",
  open: "1.28",
  price_change_percent: "+28.12%",
  volume: "1912949.46",
  amount: "1287203.14",
};

function provider(handler: (url: string) => Response): SafeTradePriceProvider {
  const fetchImpl = (async (input: RequestInfo | URL) =>
    handler(String(input))) as unknown as typeof fetch;
  return new SafeTradePriceProvider({ fetchImpl, now: () => 1_700_000_000_000 });
}

describe("SafeTradePriceProvider", () => {
  it("hits the correct PRL/USDT endpoint and parses the live shape", async () => {
    let seen = "";
    const p = provider((url) => {
      seen = url;
      return new Response(JSON.stringify(LIVE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const t = await p.getTicker();
    expect(seen).toBe("https://safetrade.com/api/v2/trade/public/tickers/prlusdt");
    expect(t.market).toBe("PRL/USDT");
    expect(t.last).toBe(1.64);
    expect(t.changePercent).toBe("+28.12%");
    expect(t.changePositive).toBe(true);
    expect(t.volumeQuoteUsd).toBe(1912949.46);
    expect(t.source).toBe("safetrade");
    expect(t.ts).toBe(1_700_000_000_000);
  });

  it("marks a negative change as not positive", async () => {
    const p = provider(() =>
      new Response(JSON.stringify({ ...LIVE, price_change_percent: "-4.20%" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const t = await p.getTicker();
    expect(t.changePositive).toBe(false);
  });

  it("throws on a Cloudflare 403 (so the hook keeps last-good)", async () => {
    const p = provider(() => new Response("<html>blocked</html>", { status: 403 }));
    await expect(p.getTicker()).rejects.toThrow();
  });

  it("throws on an unexpected shape", async () => {
    const p = provider(() =>
      new Response(JSON.stringify({ nope: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(p.getTicker()).rejects.toThrow();
  });

  it("formats price and volume for display", () => {
    expect(formatUsd(1.64)).toBe("$1.64");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatVolumeUsd(1912949.46)).toBe("$1.91M");
    expect(formatVolumeUsd(4200)).toBe("$4.2k");
  });

  it("rejects a non-https price host", () => {
    expect(() => new SafeTradePriceProvider({ baseUrl: "http://safetrade.com" })).toThrow();
  });

  it("parses the live SafeTrade k-line (string values) into close prices", async () => {
    // Verbatim response shape: [ts, open, high, low, close, volume], strings.
    const KLINE = [
      [1779505200, "0.5", "0.54", "0.4", "0.54", "201"],
      [1779508800, "0.4", "0.48", "0.4", "0.46", "245.4189"],
      [1779512400, "0.4", "0.47", "0.4", "0.47", "326.9029"],
      [1779516000, "0.47", "0.7", "0.4", "0.5", "2792.9073"],
      [1779519600, "0.48", "0.68", "0.48", "0.5", "2323.9444"],
      [1779523200, "0.5", "0.59", "0.46", "0.53", "577.733"],
      [1779526800, "0.49", "0.53", "0.39", "0.39", "1056.3782"],
      [1779530400, "0.53", "0.53", "0.49", "0.5", "554.3909"],
      [1779534000, "0.48", "0.48", "0.46", "0.46", "200.6483"],
      [1779537600, "0.42", "0.42", "0.41", "0.41", "237.329"],
      [1779541200, "0.4", "0.4", "0.3", "0.37", "10733.836"],
      [1779544800, "0.37", "0.41", "0.37", "0.4", "9653.8778"],
      [1779548400, "0.39", "0.4", "0.37", "0.39", "7129.309"],
      [1779552000, "0.39", "0.45", "0.38", "0.45", "37197.7761"],
      [1779555600, "0.45", "0.45", "0.39", "0.39", "3409.6368"],
      [1779559200, "0.39", "0.42", "0.39", "0.42", "14385.7983"],
      [1779562800, "0.42", "0.44", "0.4", "0.4", "10589.2738"],
      [1779566400, "0.41", "0.42", "0.4", "0.41", "4046.7419"],
      [1779570000, "0.41", "0.45", "0.41", "0.44", "17219.8337"],
      [1779573600, "0.44", "0.48", "0.44", "0.44", "9097.0676"],
      [1779577200, "0.44", "0.46", "0.43", "0.44", "8152.5286"],
      [1779580800, "0.44", "0.45", "0.44", "0.44", "429.1694"],
      [1779584400, "0.44", "0.49", "0.44", "0.44", "11683.47"],
      [1779588000, "0.44", "0.44", "0.44", "0.44", "1916.8871"],
    ];
    const c = provider((url) => {
      expect(url).toContain("/api/v2/trade/public/markets/prlusdt/k-line");
      return new Response(JSON.stringify(KLINE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const candles = await c.getCandles();
    expect(candles).toHaveLength(24);
    expect(candles[0]).toBe(0.54);
    expect(candles[candles.length - 1]).toBe(0.44);
  });
});
