import { describe, expect, it } from "vitest";
import {
  GRAIN_PER_PRL,
  MAX_GRAIN,
  AmountError,
  grainToPrl,
  prlToGrain,
  sumGrain,
} from "./amounts.js";

describe("amounts", () => {
  it("converts whole PRL to Grain", () => {
    expect(prlToGrain("1")).toBe(GRAIN_PER_PRL);
    expect(prlToGrain("21000000000")).toBe(MAX_GRAIN);
  });

  it("converts the smallest fractional PRL (1 Grain)", () => {
    expect(prlToGrain("0.00000001")).toBe(1n);
  });

  it("rejects more than 8 decimals", () => {
    expect(() => prlToGrain("0.000000001")).toThrow(AmountError);
  });

  it("rejects amounts over the supply cap", () => {
    expect(() => prlToGrain("21000000001")).toThrow(AmountError);
  });

  it("round-trips Grain -> PRL -> Grain", () => {
    for (const g of [0n, 1n, GRAIN_PER_PRL, 150_000_000n, MAX_GRAIN]) {
      expect(prlToGrain(grainToPrl(g))).toBe(g);
    }
  });

  it("trims trailing zeros by default", () => {
    expect(grainToPrl(150_000_000n)).toBe("1.5");
    expect(grainToPrl(GRAIN_PER_PRL)).toBe("1");
  });

  it("sums Grain amounts", () => {
    expect(sumGrain([1n, 2n, 3n])).toBe(6n);
  });
});
