import { describe, expect, it } from "vitest";
import { encodeQr } from "./qr-encode.js";

/**
 * Structural sanity checks for the matrix returned by the (verified)
 * qrcode-generator-backed encoder. Full scannability is verified out-of-band by
 * rendering to pixels and decoding with jsQR (agent verification step); these
 * tests just guard the wrapper's shape and the mandatory finder patterns.
 */

const REGTEST_ADDR =
  "rprl1plmkpatlwc840amq74lhvr6h7as02lmkpatlwc840amq74lhvr6hsueaf09w";

describe("encodeQr", () => {
  const m = encodeQr(REGTEST_ADDR);

  it("returns a square matrix sized version*4+17", () => {
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.length).toBe(m[0]!.length);
    expect((m.length - 17) % 4).toBe(0);
  });

  it("has finder patterns in all three corners", () => {
    const n = m.length;
    // Outer corner of each finder is a dark module.
    expect(m[0]![0]).toBe(true);
    expect(m[0]![n - 1]).toBe(true);
    expect(m[n - 1]![0]).toBe(true);
    // Finder centres (3x3 dark block at offset 2..4) are dark.
    expect(m[3]![3]).toBe(true);
    // The light separator ring inside the top-left finder.
    expect(m[1]![1]).toBe(false);
  });

  it("throws on empty input", () => {
    expect(() => encodeQr("")).toThrow();
  });
});
