/**
 * End-to-end tx build + sign + serialize tests.
 *
 * Pins the structure to fixtures/unsigned-tx.json (recipient + VISIBLE Necklace
 * flat fee + change) and fixtures/signed-tx.json (single 64-byte Schnorr witness
 * for the Taproot key-path), and cross-checks the BIP-341 sighash, BIP-340
 * signature, and btcd wire serialization byte-for-byte against
 * @scure/btc-signer (itself KAT-tested upstream).
 */

import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  addWalletFeeOutput,
  buildTransaction,
  impliedMinerFee,
  totalOutputValue,
  type SelectedInput,
} from "../src/transaction.js";
import { deriveAddress } from "../src/address.js";
import {
  computeTxid,
  serializeTxHex,
  type WireTx,
} from "../src/serialize.js";
import {
  signTaprootKeyInput,
  signTransaction,
  taprootKeySpendSighash,
  tweakTaprootPrivKey,
} from "../src/sign.js";
import { bytesToHex } from "./fixtures.js";

const PRIV = Uint8Array.from({ length: 32 }, (_, i) => (i % 255) + 1);
const X_ONLY = schnorr.getPublicKey(PRIV);

// The P2TR address (regtest) the wallet receives at, and its scriptPubKey.
const OWNER = deriveAddress(PRIV, "regtest");
const OWNER_SCRIPT_HEX = `5120${OWNER.witnessProgramHex}`;

// A real, derived regtest recipient (the unsigned-tx fixture's illustrative
// address is a placeholder with an invalid checksum — our decoder rightly
// rejects it, so we derive a valid one here).
const RECIPIENT = deriveAddress(
  Uint8Array.from({ length: 32 }, (_, i) => ((i * 11) % 255) + 1),
  "regtest",
).address;
const FEE_ADDR = deriveAddress(
  Uint8Array.from({ length: 32 }, (_, i) => ((i * 7) % 255) + 1),
  "regtest",
).address;
const CHANGE_ADDR = deriveAddress(
  Uint8Array.from({ length: 32 }, (_, i) => ((i * 3) % 255) + 1),
  "regtest",
).address;

function makeInput(): SelectedInput {
  return {
    txid: "1111111111111111111111111111111111111111111111111111111111111111",
    vout: 0,
    value: 500000000n,
    scriptPubKeyHex: OWNER_SCRIPT_HEX,
    confirmations: 120,
    tapInternalKey: X_ONLY,
    tapMerkleRoot: null,
  };
}

describe("buildTransaction + addWalletFeeOutput", () => {
  it("adds the Necklace flat fee as a SEPARATE, VISIBLE output before change", () => {
    const draft0 = buildTransaction(
      [{ address: RECIPIENT, value: 200000000n }],
      [makeInput()],
      CHANGE_ADDR,
      298850000n,
    );
    const draft = addWalletFeeOutput(draft0, FEE_ADDR, 1000000n);

    const roles = draft.annotatedOutputs.map((o) => o.role);
    expect(roles).toEqual(["recipient", "necklace_fee", "change"]);

    const feeOut = draft.annotatedOutputs.find((o) => o.role === "necklace_fee");
    expect(feeOut).toBeDefined();
    expect(feeOut!.value).toBe(1000000n);
    expect(feeOut!.address).toBe(FEE_ADDR);

    // The fee is a real, distinct output (not folded into recipient/change).
    expect(draft.tx.outputs).toHaveLength(3);
    expect(totalOutputValue(draft)).toBe(200000000n + 1000000n + 298850000n);
  });

  it("rejects a flat fee below the dust floor", () => {
    const draft0 = buildTransaction(
      [{ address: RECIPIENT, value: 200000000n }],
      [makeInput()],
      undefined,
      0n,
    );
    expect(() => addWalletFeeOutput(draft0, FEE_ADDR, 100n)).toThrow();
  });

  it("computes the implied miner fee as inputs - outputs", () => {
    const draft0 = buildTransaction(
      [{ address: RECIPIENT, value: 200000000n }],
      [makeInput()],
      CHANGE_ADDR,
      298850000n,
    );
    const draft = addWalletFeeOutput(draft0, FEE_ADDR, 1000000n);
    // 500000000 - (200000000 + 1000000 + 298850000) = 150000
    expect(impliedMinerFee(draft)).toBe(150000n);
  });
});

describe("signing (BIP-341 sighash + BIP-340 Schnorr key-path)", () => {
  it("produces a single 64-byte witness item per input (SigHashDefault)", () => {
    const draft0 = buildTransaction(
      [{ address: RECIPIENT, value: 200000000n }],
      [makeInput()],
      CHANGE_ADDR,
      298850000n,
    );
    const draft = addWalletFeeOutput(draft0, FEE_ADDR, 1000000n);

    const signed = signTransaction(draft.tx, draft.signingInputs, () => PRIV);
    expect(signed.inputs).toHaveLength(1);
    expect(signed.inputs[0]!.witness).toHaveLength(1);
    expect(signed.inputs[0]!.witness[0]!.length).toBe(64);
  });

  it("signature verifies against the tweaked output key", () => {
    const draft = addWalletFeeOutput(
      buildTransaction(
        [{ address: RECIPIENT, value: 200000000n }],
        [makeInput()],
        CHANGE_ADDR,
        298850000n,
      ),
      FEE_ADDR,
      1000000n,
    );
    const prevValues = draft.signingInputs.map((i) => i.prevValue);
    const prevScripts = draft.signingInputs.map((i) => i.prevPkScript);
    const sighash = taprootKeySpendSighash(draft.tx, 0, prevValues, prevScripts);
    const wit = signTaprootKeyInput(
      draft.tx,
      0,
      PRIV,
      prevValues,
      prevScripts,
      null,
    );
    const outKey = schnorr.getPublicKey(tweakTaprootPrivKey(PRIV, null));
    expect(schnorr.verify(wit[0]!, sighash, outKey)).toBe(true);
  });
});

describe("byte-for-byte parity with @scure/btc-signer", () => {
  // Build the SAME tx in both our pipeline and scure, then compare raw hex,
  // txid, and the per-input sighash. scure is independently KAT-tested.
  function buildBoth() {
    const draft = addWalletFeeOutput(
      buildTransaction(
        [{ address: RECIPIENT, value: 200000000n }],
        [makeInput()],
        CHANGE_ADDR,
        298850000n,
      ),
      FEE_ADDR,
      1000000n,
    );

    const stx = new btc.Transaction({ version: 1, allowUnknownOutputs: true });
    const input = makeInput();
    stx.addInput({
      txid: Uint8Array.from(
        input.txid.match(/../g)!.map((h) => parseInt(h, 16)),
      ).reverse(),
      index: input.vout,
      witnessUtxo: {
        amount: input.value,
        script: Uint8Array.from(
          OWNER_SCRIPT_HEX.match(/../g)!.map((h) => parseInt(h, 16)),
        ),
      },
      tapInternalKey: X_ONLY,
      sequence: 0xffffffff,
    });
    // Same output order: recipient, necklace_fee, change.
    for (const o of draft.annotatedOutputs) {
      stx.addOutput({ script: o.pkScript, amount: o.value });
    }
    return { draft, stx };
  }

  it("unsigned sighash matches scure.preimageWitnessV1", () => {
    const { draft, stx } = buildBoth();
    const prevValues = draft.signingInputs.map((i) => i.prevValue);
    const prevScripts = draft.signingInputs.map((i) => i.prevPkScript);
    const mine = taprootKeySpendSighash(draft.tx, 0, prevValues, prevScripts);
    const theirs = stx.preimageWitnessV1(0, prevScripts as Uint8Array[], 0x00, [
      ...prevValues,
    ]);
    expect(bytesToHex(mine)).toBe(bytesToHex(theirs));
  });

  it("signed raw tx hex + txid match scure (deterministic auxRand)", () => {
    const { draft, stx } = buildBoth();
    const signed: WireTx = signTransaction(
      draft.tx,
      draft.signingInputs,
      () => PRIV,
      () => new Uint8Array(32),
    );

    stx.signIdx(PRIV, 0, undefined, new Uint8Array(32));
    stx.finalize();

    expect(serializeTxHex(signed, true)).toBe(stx.hex);
    expect(computeTxid(signed)).toBe(stx.id);
  });
});
