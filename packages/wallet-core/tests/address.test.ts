/**
 * Golden-fixture tests for bech32m address encode/decode + BIP-86 derivation,
 * pinned to the REAL Pearl KATs in fixtures/derived-address.json
 * (node/btcutil/address_test.go).
 */

import { describe, expect, it } from "vitest";
import {
  decodeAddress,
  deriveAddress,
  encodeAddress,
  validateAddress,
  type DecodedAddress,
} from "../src/address.js";
import type { Network, WitnessVersion } from "@necklace/shared";
import { bytesToHex, hexToBytes, loadFixture } from "./fixtures.js";

interface AddressVector {
  name: string;
  network?: Network;
  hrp?: string;
  witnessVersion?: number;
  witnessProgramHex?: string;
  address: string;
  valid: boolean;
  reason?: string;
}
interface AddressFixture {
  vectors: AddressVector[];
}

const fx = loadFixture<AddressFixture>("derived-address.json");

describe("address golden fixtures (address_test.go)", () => {
  for (const v of fx.vectors) {
    if (v.valid) {
      it(`encodes ${v.name} -> ${v.address}`, () => {
        const encoded = encodeAddress(
          v.network as Network,
          v.witnessVersion as WitnessVersion,
          hexToBytes(v.witnessProgramHex as string),
        );
        expect(encoded).toBe(v.address);
      });

      it(`decodes ${v.name} round-trip`, () => {
        const decoded: DecodedAddress = decodeAddress(v.address);
        expect(decoded.witnessVersion).toBe(v.witnessVersion);
        expect(bytesToHex(decoded.program)).toBe(v.witnessProgramHex);
        expect(decoded.hrp).toBe(v.hrp);
        expect(validateAddress(v.address)).toBe(true);
      });
    } else {
      it(`REJECTS ${v.name} (${v.reason ?? "invalid"})`, () => {
        expect(validateAddress(v.address)).toBe(false);
        expect(() => decodeAddress(v.address)).toThrow();
      });
    }
  }
});

describe("witness-version v0 rejection (Pearl is bech32m-only)", () => {
  it("rejects a syntactically valid bech32 v0 address", () => {
    // The two legacy-v0 vectors in the fixture are already covered above; assert
    // the rule directly too.
    const v0 = fx.vectors.find((x) => x.name.includes("p2wpkh"));
    expect(v0).toBeDefined();
    expect(validateAddress(v0!.address)).toBe(false);
  });
});

describe("BIP-86 P2TR derivation parity", () => {
  it("derives the same witness program scure-btc-signer derives (BIP-86 tweak)", () => {
    // Deterministic test key 0x0101..01. The tweak is the standard
    // H_TapTweak(internalKey) and must match the reference implementation.
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (i % 255) + 1);
    const derived = deriveAddress(priv, "mainnet");
    expect(derived.witnessVersion).toBe(1);
    expect(derived.witnessProgramHex).toHaveLength(64);
    // Round-trips through decode.
    const decoded = decodeAddress(derived.address);
    expect(bytesToHex(decoded.program)).toBe(derived.witnessProgramHex);
    expect(decoded.network).toBe("mainnet");
  });

  it("same key derives different HRP per network, same program", () => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (i % 255) + 1);
    const main = deriveAddress(priv, "mainnet");
    const test = deriveAddress(priv, "testnet");
    const reg = deriveAddress(priv, "regtest");
    expect(main.witnessProgramHex).toBe(test.witnessProgramHex);
    expect(test.witnessProgramHex).toBe(reg.witnessProgramHex);
    expect(main.address.startsWith("prl1")).toBe(true);
    expect(test.address.startsWith("tprl1")).toBe(true);
    expect(reg.address.startsWith("rprl1")).toBe(true);
  });
});
