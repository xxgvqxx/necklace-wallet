/**
 * Sign-what-you-see parity (security-critical).
 *
 * BIP-341 commits every input's prevValue + prevScript in the sighash. So if a
 * malicious backend lies about a UTXO's value, the only thing that changes is
 * the sighash the wallet signs — NOT the outputs. The recipient, the visible
 * Necklace fee, and the change are fixed by the user-approved draft. The result
 * of a lie is therefore a signature that FAILS verification (the tx is rejected
 * by the network), never a redirected payment.
 *
 * These tests demonstrate that property directly against wallet-core's signer.
 */

import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  addWalletFeeOutput,
  buildTransaction,
  type SelectedInput,
} from "../src/transaction.js";
import { deriveAddress } from "../src/address.js";
import {
  signTaprootKeyInput,
  taprootKeySpendSighash,
  tweakTaprootPrivKey,
} from "../src/sign.js";

const PRIV = Uint8Array.from({ length: 32 }, (_, i) => (i % 255) + 1);
const X_ONLY = schnorr.getPublicKey(PRIV);
const OWNER = deriveAddress(PRIV, "regtest");
const OWNER_SCRIPT_HEX = `5120${OWNER.witnessProgramHex}`;
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

const TRUE_VALUE = 500_000_000n;

function makeInput(value: bigint): SelectedInput {
  return {
    txid: "1111111111111111111111111111111111111111111111111111111111111111",
    vout: 0,
    value,
    scriptPubKeyHex: OWNER_SCRIPT_HEX,
    confirmations: 120,
    tapInternalKey: X_ONLY,
    tapMerkleRoot: null,
  };
}

function buildDraft(inputValue: bigint) {
  return addWalletFeeOutput(
    buildTransaction(
      [{ address: RECIPIENT, value: 200_000_000n }],
      [makeInput(inputValue)],
      CHANGE_ADDR,
      298_850_000n,
    ),
    FEE_ADDR,
    1_000_000n,
  );
}

describe("a lying-UTXO-value backend yields an INVALID signature, not a redirect", () => {
  it("a signature made under a LIED prevValue fails against the TRUE prevValue", () => {
    // The wallet was told the input is worth a different (smaller) amount than
    // its true on-chain value — e.g. an indexer lying to inflate the implied fee.
    const liedValue = 400_000_000n;
    const draft = buildDraft(liedValue);

    // Sign committing to the LIED value (what the wallet would do if it trusted
    // the backend's prevValue).
    const wit = signTaprootKeyInput(
      draft.tx,
      0,
      PRIV,
      [liedValue],
      [draft.signingInputs[0]!.prevPkScript],
      null,
    );
    const outKey = schnorr.getPublicKey(tweakTaprootPrivKey(PRIV, null));

    // The node verifies against the TRUE prevValue. The signature must NOT verify.
    const trueSighash = taprootKeySpendSighash(
      draft.tx,
      0,
      [TRUE_VALUE],
      [draft.signingInputs[0]!.prevPkScript],
    );
    expect(schnorr.verify(wit[0]!, trueSighash, outKey)).toBe(false);

    // It DOES verify against the lied sighash (proving the only thing that broke
    // is the value commitment, not the signing math).
    const liedSighash = taprootKeySpendSighash(
      draft.tx,
      0,
      [liedValue],
      [draft.signingInputs[0]!.prevPkScript],
    );
    expect(schnorr.verify(wit[0]!, liedSighash, outKey)).toBe(true);
  });

  it("the OUTPUTS are identical whether the value is lied about or not (no redirect)", () => {
    const honest = buildDraft(TRUE_VALUE);
    const lied = buildDraft(400_000_000n);
    // The recipient / fee / change scripts + values are byte-identical: a lie
    // about the input value cannot move funds to a different output.
    const outs = (d: typeof honest) =>
      d.tx.outputs.map((o) => `${Buffer.from(o.pkScript).toString("hex")}:${o.value}`);
    expect(outs(lied)).toEqual(outs(honest));
    expect(outs(honest)).toEqual([
      `5120${deriveAddress(Uint8Array.from({ length: 32 }, (_, i) => ((i * 11) % 255) + 1), "regtest").witnessProgramHex}:200000000`,
      `5120${deriveAddress(Uint8Array.from({ length: 32 }, (_, i) => ((i * 7) % 255) + 1), "regtest").witnessProgramHex}:1000000`,
      `5120${deriveAddress(Uint8Array.from({ length: 32 }, (_, i) => ((i * 3) % 255) + 1), "regtest").witnessProgramHex}:298850000`,
    ]);
  });

  it("outputs stay in canonical order [recipient, necklace_fee, change]", () => {
    const draft = buildDraft(TRUE_VALUE);
    expect(draft.annotatedOutputs.map((o) => o.role)).toEqual([
      "recipient",
      "necklace_fee",
      "change",
    ]);
  });
});
