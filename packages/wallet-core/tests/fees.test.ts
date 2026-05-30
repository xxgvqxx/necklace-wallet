/**
 * Fee-model tests, pinned to Pearl's vsize/fee math
 * (node/blockchain/vsize.go, wallet/wallet/txsizes/size.go,
 * wallet/wallet/txrules/rules.go) and the unsigned-tx fixture units.
 */

import { describe, expect, it } from "vitest";
import {
  assertValidFlatFee,
  calcVsize,
  estimateNetworkFee,
  estimateVirtualSize,
  feeForSerializeSize,
  FeeError,
  P2TR_OUTPUT_SIZE,
  P2TR_PK_SCRIPT_SIZE,
  REDEEM_P2TR_INPUT_SIZE,
  REDEEM_P2TR_INPUT_WITNESS_WEIGHT,
  varIntSerializeSize,
} from "../src/fees.js";

describe("Pearl size constants", () => {
  it("matches txsizes/size.go", () => {
    expect(P2TR_PK_SCRIPT_SIZE).toBe(34); // 1+1+32
    expect(P2TR_OUTPUT_SIZE).toBe(43); // 8+1+34
    expect(REDEEM_P2TR_INPUT_SIZE).toBe(41); // 32+4+1+0+4
    expect(REDEEM_P2TR_INPUT_WITNESS_WEIGHT).toBe(67); // 1+1+65
  });
});

describe("calcVsize (vsize.go)", () => {
  it("vsize = base + ceil(witness/4)", () => {
    expect(calcVsize(100, 0)).toBe(100);
    expect(calcVsize(100, 1)).toBe(101); // ceil(1/4)=1
    expect(calcVsize(100, 4)).toBe(101);
    expect(calcVsize(100, 5)).toBe(102);
    expect(calcVsize(100, 67)).toBe(100 + 17); // ceil(67/4)=17
  });
});

describe("varIntSerializeSize (wire)", () => {
  it("matches btcd thresholds", () => {
    expect(varIntSerializeSize(0)).toBe(1);
    expect(varIntSerializeSize(0xfc)).toBe(1);
    expect(varIntSerializeSize(0xfd)).toBe(3);
    expect(varIntSerializeSize(0xffff)).toBe(3);
    expect(varIntSerializeSize(0x10000)).toBe(5);
  });
});

describe("estimateVirtualSize (txsizes.EstimateVirtualSize, Taproot-only)", () => {
  it("computes the worst-case vsize by hand for 1-in / 1-out + change", () => {
    // baseSize = 8 + varint(1) + varint(2) + 1*41 + (8+1+34) + (8+1+34)
    //          = 8 + 1 + 1 + 41 + 43 + 43 = 137
    // witness  = 2 + varint(1) + 1*67 = 70
    // vsize    = 137 + ceil(70/4) = 137 + 18 = 155
    const vsize = estimateVirtualSize(1, [P2TR_PK_SCRIPT_SIZE], true);
    expect(vsize).toBe(155);
  });

  it("no inputs => zero witness weight", () => {
    // baseSize = 8 + varint(0) + varint(1) + 0 + 43 = 53, witness 0
    const vsize = estimateVirtualSize(0, [P2TR_PK_SCRIPT_SIZE], false);
    expect(vsize).toBe(53);
  });
});

describe("feeForSerializeSize (txrules.FeeForSerializeSize)", () => {
  it("fee = relayFeePerKb * size / 1000", () => {
    expect(feeForSerializeSize(1000n, 155)).toBe(155n);
    expect(feeForSerializeSize(2000n, 155)).toBe(310n);
  });
  it("floors at relayFeePerKb when result would be 0", () => {
    expect(feeForSerializeSize(1000n, 0)).toBe(1000n);
  });
});

describe("estimateNetworkFee", () => {
  it("1-in/1-out+change at default relay fee is the vsize in Grain", () => {
    expect(estimateNetworkFee(1, [P2TR_PK_SCRIPT_SIZE], true)).toBe(155n);
  });
});

describe("assertValidFlatFee", () => {
  it("accepts a fee above dust", () => {
    expect(() =>
      assertValidFlatFee({ flatFeeGrain: 1_000_000n, feeAddress: "x" }),
    ).not.toThrow();
  });
  it("rejects a fee below dust", () => {
    expect(() =>
      assertValidFlatFee({ flatFeeGrain: 100n, feeAddress: "x" }),
    ).toThrow(FeeError);
  });
  it("rejects a negative fee", () => {
    expect(() =>
      assertValidFlatFee({ flatFeeGrain: -1n, feeAddress: "x" }),
    ).toThrow(FeeError);
  });
});
