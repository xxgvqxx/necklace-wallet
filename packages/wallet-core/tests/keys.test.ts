/**
 * Golden-fixture tests for WIF / raw-hex private-key import, pinned to the REAL
 * Pearl KATs in fixtures/import-key.json (node/btcutil/wif_test.go).
 */

import { describe, expect, it } from "vitest";
import {
  decodeWif,
  importPrivateKey,
  importRawHex,
  KeyImportError,
} from "../src/keys.js";
import { WIF_NETID_BY_NETWORK, type Network } from "@necklace/shared";
import { bytesToHex, loadFixture } from "./fixtures.js";

interface WifVector {
  name: string;
  network?: Network;
  privateKeyHex?: string;
  compressed?: boolean;
  wif: string;
  expectedPubKeyHex?: string;
  expectError?: string;
}
interface WifFixture {
  vectors: WifVector[];
}

const fx = loadFixture<WifFixture>("import-key.json");

describe("WIF import golden fixtures (wif_test.go)", () => {
  for (const v of fx.vectors) {
    if (v.expectError) {
      it(`rejects ${v.name} with ${v.expectError}`, () => {
        let thrown: unknown;
        try {
          decodeWif(v.wif);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(KeyImportError);
        expect((thrown as KeyImportError).code).toBe(v.expectError);
      });
      continue;
    }

    it(`decodes ${v.name}`, () => {
      const imported = decodeWif(v.wif);
      expect(bytesToHex(imported.privateKey)).toBe(v.privateKeyHex);
      expect(imported.compressed).toBe(v.compressed);
      expect(imported.netID).toBe(WIF_NETID_BY_NETWORK[v.network as Network]);
      expect(imported.networks).toContain(v.network);
    });

    it(`derives the expected pubkey for ${v.name}`, () => {
      const imported = decodeWif(v.wif);
      const pub = v.compressed
        ? imported.publicKeyCompressed
        : imported.publicKeyUncompressed;
      expect(bytesToHex(pub)).toBe(v.expectedPubKeyHex);
    });
  }
});

describe("raw-hex import", () => {
  it("imports a 64-char hex key and derives x-only + compressed pubkeys", () => {
    const hex =
      "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d";
    const imported = importRawHex(hex);
    expect(bytesToHex(imported.privateKey)).toBe(hex);
    expect(imported.compressed).toBe(true);
    expect(imported.netID).toBeUndefined();
    expect(imported.networks).toHaveLength(0);
    expect(imported.xOnlyPublicKey).toHaveLength(32);
    expect(imported.publicKeyCompressed).toHaveLength(33);
    // x-only is the compressed key without the parity byte.
    expect(bytesToHex(imported.xOnlyPublicKey)).toBe(
      bytesToHex(imported.publicKeyCompressed.slice(1)),
    );
  });

  it("accepts a 0x prefix", () => {
    const hex =
      "0x0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d";
    expect(() => importRawHex(hex)).not.toThrow();
  });

  it("rejects wrong-length hex", () => {
    expect(() => importRawHex("deadbeef")).toThrow(KeyImportError);
  });

  it("rejects an all-zero (out-of-range) scalar", () => {
    expect(() => importRawHex("00".repeat(32))).toThrow(/valid secp256k1 scalar/);
  });
});

describe("importPrivateKey auto-detection", () => {
  it("routes a 64-char hex string to raw-hex import", () => {
    const hex =
      "dda35a1488fb97b6eb3fe6e9ef2a25814e396fb5dc295fe994b96789b21a0398";
    const imported = importPrivateKey(hex);
    expect(bytesToHex(imported.privateKey)).toBe(hex);
    expect(imported.netID).toBeUndefined();
  });

  it("routes a WIF string to WIF import", () => {
    const imported = importPrivateKey(
      "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ",
    );
    expect(imported.netID).toBe(0x80);
  });
});
