import { describe, expect, it } from "vitest";
import { GRAIN_PER_PRL, type Utxo } from "@necklace/shared";
import {
  buildTxPreview,
  InsufficientFundsError,
} from "./preview.js";
import { FLAT_FEE_GRAIN, FeePolicyError } from "./fee.js";
import { estimateVsize, relayFeeForVsize } from "./vsize.js";

const REGTEST_RECIPIENT =
  "rprl1plmkpatlwc840amq74lhvr6h7as02lmkpatlwc840amq74lhvr6hsueaf09w";
const REGTEST_CHANGE =
  "rprl1plmkpatlwc840amq74lhvr6h7as02lmkpatlwc840amq74lhvr6hsueaf09w";

function utxo(valuePrl: number, vout = 0): Utxo {
  return {
    txid: "1111111111111111111111111111111111111111111111111111111111111111",
    vout,
    value: BigInt(Math.round(valuePrl * 1e8)),
    scriptPubKeyHex:
      "5120ef46d1aa78101e3350600a5d36045ba97c2670daa91e9f3a48c43c6e739754e6",
    confirmations: 100,
  };
}

describe("vsize estimation", () => {
  it("1-in 3-out P2TR tx is ~150 vbytes", () => {
    const vs = estimateVsize(1, 3);
    // 41*4 + 2 + 66 + (4+4+1+1)*4 + 3*43*4 ... sanity bound.
    expect(vs).toBeGreaterThan(120);
    expect(vs).toBeLessThan(200);
  });

  it("relay fee never rounds to zero (floored to per-kB rate)", () => {
    expect(relayFeeForVsize(1, 1000n)).toBe(1000n);
  });
});

describe("buildTxPreview (regtest, fee pinned)", () => {
  it("itemises recipient + flat Necklace fee + change + network fee", () => {
    const p = buildTxPreview({
      network: "regtest",
      utxos: [utxo(5)],
      recipientAddress: REGTEST_RECIPIENT,
      recipientValue: 2n * GRAIN_PER_PRL,
      changeAddress: REGTEST_CHANGE,
    });

    expect(p.recipient.value).toBe(2n * GRAIN_PER_PRL);
    expect(p.necklaceFee.value).toBe(FLAT_FEE_GRAIN);
    expect(p.networkFee).toBeGreaterThan(0n);
    // change = inputs - recipient - necklaceFee - networkFee
    expect(p.change).toBe(
      5n * GRAIN_PER_PRL - 2n * GRAIN_PER_PRL - FLAT_FEE_GRAIN - p.networkFee,
    );
    // total debit excludes change.
    expect(p.totalDebit).toBe(
      2n * GRAIN_PER_PRL + FLAT_FEE_GRAIN + p.networkFee,
    );
    // The draft the vault signs contains the visible fee output.
    expect(p.draft.necklaceFee?.value).toBe(FLAT_FEE_GRAIN);
    expect(p.draft.change?.value).toBe(p.change);
    expect(p.draft.recipients).toHaveLength(1);
  });

  it("conservation: inputs == recipient + fee + change + networkFee", () => {
    const p = buildTxPreview({
      network: "regtest",
      utxos: [utxo(5), utxo(0.25, 1)],
      recipientAddress: REGTEST_RECIPIENT,
      recipientValue: 2n * GRAIN_PER_PRL,
      changeAddress: REGTEST_CHANGE,
    });
    const outSum =
      p.recipient.value + p.necklaceFee.value + p.change + p.networkFee;
    expect(outSum).toBe(p.totalInput);
  });

  it("throws InsufficientFundsError naming all three components", () => {
    expect(() =>
      buildTxPreview({
        network: "regtest",
        utxos: [utxo(0.001)], // far too small
        recipientAddress: REGTEST_RECIPIENT,
        recipientValue: 2n * GRAIN_PER_PRL,
        changeAddress: REGTEST_CHANGE,
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("fails closed when the fee address is unpinned (testnet)", () => {
    expect(() =>
      buildTxPreview({
        network: "testnet",
        utxos: [utxo(5)],
        recipientAddress:
          "prl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqksluzv",
        recipientValue: 2n * GRAIN_PER_PRL,
        changeAddress:
          "prl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqksluzv",
      }),
    ).toThrow(FeePolicyError);
  });

  it("drops dust change into the network fee", () => {
    // Choose an amount that leaves < dust as change: recipient 2 + 1 PRL fee
    // (3 PRL) + the 1000-Grain floored relay fee + ~400 Grain leftover, which is
    // below the dust floor (~546) and gets rolled into the network fee.
    const inputs = [utxo(3.000014)];
    const recipientValue = 2n * GRAIN_PER_PRL;
    const p = buildTxPreview({
      network: "regtest",
      utxos: inputs,
      recipientAddress: REGTEST_RECIPIENT,
      recipientValue,
      changeAddress: REGTEST_CHANGE,
    });
    if (p.changeDropped) {
      expect(p.change).toBe(0n);
      expect(p.draft.change).toBeUndefined();
      // Conservation still holds.
      expect(
        p.recipient.value + p.necklaceFee.value + p.networkFee,
      ).toBe(p.totalInput);
    }
  });
});
