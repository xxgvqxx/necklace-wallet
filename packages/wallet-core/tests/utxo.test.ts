/**
 * Coin-selection tests, pinned to fixtures/utxos.json (regtest shape derived
 * from wallet/wallet/createtx.go findEligibleOutputs + makeInputSource).
 */

import { describe, expect, it } from "vitest";
import {
  CoinSelectionError,
  filterEligible,
  selectUtxos,
  sortLargestFirst,
  spendableTotal,
  type CandidateUtxo,
} from "../src/utxo.js";
import { P2TR_PK_SCRIPT_SIZE } from "../src/fees.js";
import { loadFixture } from "./fixtures.js";

interface UtxoFixture {
  spendableTotalGrain: number;
  utxos: {
    outpoint: { txid: string; vout: number };
    value: number;
    pkScript: string;
    confirmations: number;
    fromCoinbase: boolean;
    spendable: boolean;
  }[];
}

const fx = loadFixture<UtxoFixture>("utxos.json");

function toCandidates(): CandidateUtxo[] {
  return fx.utxos.map((u) => ({
    txid: u.outpoint.txid,
    vout: u.outpoint.vout,
    value: BigInt(u.value),
    scriptPubKeyHex: u.pkScript,
    confirmations: u.confirmations,
    fromCoinbase: u.fromCoinbase,
    // Note: we do NOT pass the fixture's `spendable` flag so eligibility is
    // computed from the rules (P2TR + maturity + confirmations), proving the
    // filter matches the fixture's own spendable determination.
  }));
}

describe("eligibility filter (findEligibleOutputs)", () => {
  it("excludes the immature coinbase, keeps confirmed P2TR outputs", () => {
    const eligible = filterEligible(toCandidates(), 1);
    const txids = eligible.map((u) => u.txid);
    // utxo #3 is an immature coinbase (40 < 100 confs) -> excluded.
    expect(txids).not.toContain("3".repeat(64));
    expect(eligible).toHaveLength(2);
  });

  it("spendableTotal matches the fixture", () => {
    expect(spendableTotal(toCandidates(), 1)).toBe(
      BigInt(fx.spendableTotalGrain),
    );
  });

  it("sorts largest-first", () => {
    const sorted = sortLargestFirst(filterEligible(toCandidates(), 1));
    expect(sorted[0]!.value).toBe(500000000n);
    expect(sorted[1]!.value).toBe(25000000n);
  });
});

describe("selectUtxos (largest-first greedy, fee-aware)", () => {
  const feePolicy = {
    flatFeeGrain: 1_000_000n,
    // recipient + visible Necklace fee outputs, both P2TR (34 bytes each).
    outputScriptSizes: [P2TR_PK_SCRIPT_SIZE, P2TR_PK_SCRIPT_SIZE],
  };

  it("funds a 2 PRL send from the single 5 PRL input with change", () => {
    const res = selectUtxos(toCandidates(), 200_000_000n, feePolicy);
    expect(res.selected).toHaveLength(1);
    expect(res.selected[0]!.value).toBe(500000000n); // largest first
    expect(res.totalInputGrain).toBe(500000000n);
    expect(res.recipientGrain).toBe(200000000n);
    expect(res.flatFeeGrain).toBe(1000000n);
    expect(res.hasChange).toBe(true);
    // inputs == recipient + flat fee + network fee + change
    expect(
      res.recipientGrain +
        res.flatFeeGrain +
        res.networkFeeGrain +
        res.changeGrain,
    ).toBe(res.totalInputGrain);
    expect(res.changeGrain).toBeGreaterThanOrEqual(546n);
  });

  it("pulls a second input when the largest alone is insufficient", () => {
    // Need ~5.1 PRL recipient + 0.01 flat fee; the single 5 PRL input cannot
    // cover it, so the selector must pull the 0.25 PRL input too. Total
    // available (5.25 PRL) covers recipient + flat fee + network fee.
    const res = selectUtxos(toCandidates(), 510_000_000n, feePolicy);
    expect(res.selected).toHaveLength(2);
    expect(res.totalInputGrain).toBe(525000000n);
  });

  it("balances exactly: inputs == recipient + flat fee + network fee + change", () => {
    const res = selectUtxos(toCandidates(), 510_000_000n, feePolicy);
    expect(
      res.recipientGrain +
        res.flatFeeGrain +
        res.networkFeeGrain +
        res.changeGrain,
    ).toBe(res.totalInputGrain);
  });

  it("throws when funds are insufficient", () => {
    expect(() =>
      selectUtxos(toCandidates(), 10_000_000_000n, feePolicy),
    ).toThrow(CoinSelectionError);
  });
});
