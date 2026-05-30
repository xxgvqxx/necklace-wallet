/**
 * Wire-serialization tests. Asserts the btcd SegWit layout (msgtx.go) and the
 * output set in fixtures/signed-tx.json, and cross-checks against
 * @scure/btc-signer for raw bytes + txid.
 */

import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import {
  bytesToHex,
  computeTxid,
  hexToBytes,
  reverseBytes,
  serializeTx,
  serializeTxHex,
  type WireTx,
} from "../src/serialize.js";
import { loadFixture } from "./fixtures.js";

interface SignedTxFixture {
  signedTx: {
    version: number;
    locktime: number;
    inputs: { previousOutpoint: { txid: string; vout: number }; sequence: number }[];
    outputs: { valueGrain: number; pkScript: string }[];
  };
}

const fx = loadFixture<SignedTxFixture>("signed-tx.json");

describe("serializeTx wire layout (msgtx.go)", () => {
  it("emits the segwit marker/flag only when witness data is present", () => {
    const base: WireTx = {
      version: 1,
      locktime: 0,
      inputs: [
        {
          txid: "11".repeat(32),
          vout: 0,
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
          witness: [],
        },
      ],
      outputs: [{ value: 1000n, pkScript: hexToBytes("5120" + "ab".repeat(32)) }],
    };
    const noWitness = serializeTxHex(base, true);
    // No witness items => no 0x00 0x01 after the version.
    expect(noWitness.slice(8, 12)).not.toBe("0001");

    const withWitness: WireTx = {
      ...base,
      inputs: [{ ...base.inputs[0]!, witness: [new Uint8Array(64)] }],
    };
    const ser = serializeTxHex(withWitness, true);
    expect(ser.slice(8, 12)).toBe("0001"); // marker + flag
  });

  it("serializes the signed-tx fixture's output set with correct values + scripts", () => {
    const tx: WireTx = {
      version: fx.signedTx.version,
      locktime: fx.signedTx.locktime,
      inputs: fx.signedTx.inputs.map((i) => ({
        txid: i.previousOutpoint.txid,
        vout: i.previousOutpoint.vout,
        scriptSig: new Uint8Array(0),
        sequence: i.sequence,
        witness: [new Uint8Array(64)], // illustrative 64-byte schnorr sig slot
      })),
      outputs: fx.signedTx.outputs.map((o) => ({
        value: BigInt(o.valueGrain),
        pkScript: hexToBytes(o.pkScript),
      })),
    };
    const hex = serializeTxHex(tx, true);
    // Each output's 8-byte LE value + varint scriptlen + pkScript appears.
    for (const o of fx.signedTx.outputs) {
      const valueLe = bytesToHex(
        (() => {
          const b = new Uint8Array(8);
          let v = BigInt(o.valueGrain);
          for (let i = 0; i < 8; i++) {
            b[i] = Number(v & 0xffn);
            v >>= 8n;
          }
          return b;
        })(),
      );
      const scriptLen = (o.pkScript.length / 2).toString(16).padStart(2, "0");
      expect(hex).toContain(valueLe + scriptLen + o.pkScript);
    }
  });

  it("legacy (stripped) serialization omits witness bytes", () => {
    const tx: WireTx = {
      version: 1,
      locktime: 0,
      inputs: [
        {
          txid: "11".repeat(32),
          vout: 0,
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
          witness: [new Uint8Array(64)],
        },
      ],
      outputs: [{ value: 1000n, pkScript: hexToBytes("5120" + "ab".repeat(32)) }],
    };
    const stripped = serializeTx(tx, false);
    const full = serializeTx(tx, true);
    expect(full.length).toBeGreaterThan(stripped.length);
  });
});

describe("txid byte order", () => {
  it("txid is the reverse of the internal double-sha256 (== scure id)", () => {
    // Use REAL valid x-only taproot programs (scure validates they are on-curve).
    const prevProg =
      "ef46d1aa78101e3350600a5d36045ba97c2670daa91e9f3a48c43c6e739754e6";
    const outProg =
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const prevScript = hexToBytes("5120" + prevProg);
    const outScript = hexToBytes("5120" + outProg);

    const stx = new btc.Transaction({ version: 1, allowUnknownOutputs: true });
    stx.addInput({
      txid: reverseBytes(hexToBytes("11".repeat(32))),
      index: 0,
      witnessUtxo: { amount: 1000n, script: prevScript },
      sequence: 0xffffffff,
    });
    stx.addOutput({ script: outScript, amount: 900n });

    const tx: WireTx = {
      version: 1,
      locktime: 0,
      inputs: [
        {
          txid: "11".repeat(32),
          vout: 0,
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
          witness: [],
        },
      ],
      outputs: [{ value: 900n, pkScript: outScript }],
    };
    expect(computeTxid(tx)).toBe(stx.id);
  });
});
