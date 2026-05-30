import { describe, expect, it } from "vitest";
import { GRAIN_PER_PRL, type TxDraft } from "@necklace/shared";
import { fromWireTxDraft, toWireTxDraft } from "./tx-wire.js";

const ADDR = "prl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqksluzv";

const draft: TxDraft = {
  network: "mainnet",
  inputs: [
    {
      txid: "ab".repeat(32),
      vout: 0,
      value: 5n * GRAIN_PER_PRL,
      scriptPubKeyHex: "5120" + "ef".repeat(32),
      confirmations: 100,
    },
  ],
  recipients: [{ address: ADDR, value: 2n * GRAIN_PER_PRL }],
  change: { address: ADDR, value: 1_990_000_000n },
  necklaceFee: { address: ADDR, value: GRAIN_PER_PRL },
  minerFee: 150n,
};

describe("tx-wire", () => {
  it("round-trips a TxDraft, preserving bigint Grain amounts", () => {
    expect(fromWireTxDraft(toWireTxDraft(draft))).toEqual(draft);
  });

  it("produces a JSON-serializable wire form (the bug: bigint isn't)", () => {
    // A raw TxDraft cannot be JSON-serialized (bigint) — this is what made
    // chrome.runtime.sendMessage fail with 'Could not serialize message'.
    expect(() => JSON.stringify(draft)).toThrow();
    // The wire form serializes fine.
    const wire = toWireTxDraft(draft);
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });

  it("keeps Grain amounts as decimal strings on the wire", () => {
    const wire = toWireTxDraft(draft);
    expect(wire.minerFee).toBe("150");
    expect(wire.necklaceFee?.value).toBe(GRAIN_PER_PRL.toString());
    expect(wire.inputs[0]?.value).toBe((5n * GRAIN_PER_PRL).toString());
  });
});
